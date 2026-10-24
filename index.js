
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const Razorpay = require("razorpay");

const app = express();
app.use(express.json({ limit: "100kb" }));

// Website origins allowed to call this backend.
// localhost is for development only.
const allowedOrigins = [
  "https://business-mindset-ac77c.web.app",
  "https://business-mindset-ac77c.firebaseapp.com",
  "http://localhost:8158"
];

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Firebase Admin credentials must be configured in Render.
if (!admin.apps.length) {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (serviceAccountJson) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(serviceAccountJson))
    });
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault()
    });
  }
}

const db = admin.firestore();
const auth = admin.auth();

const packages = {
  "E-Lite": 599,
  "Silver": 1199,
  "Gold": 2399,
  "Diamond": 4199,
  "Platinum": 6999,
  "Premium Pro": 9999,
  "Master Pro": 15999
};

const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;

const razorpay =
  razorpayKeyId && razorpayKeySecret
    ? new Razorpay({
        key_id: razorpayKeyId,
        key_secret: razorpayKeySecret
      })
    : null;

function sendError(res, status, message) {
  return res.status(status).json({ success: false, message });
}

// Verify Firebase ID token.
async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer (.+)$/i);

    if (!match) {
      return sendError(res, 401, "Firebase login token is required.");
    }

    req.user = await auth.verifyIdToken(match[1]);
    next();
  } catch (error) {
    return sendError(res, 401, "Login expired. Please sign in again.");
  }
}

app.get("/", (req, res) => {
  res.json({
    service: "Business Mindset Backend",
    status: "running"
  });
});

app.get("/health", (req, res) => {
  res.json({
    service: "Business Mindset Backend",
    status: "running"
  });
});

app.get("/api/packages", (req, res) => {
  res.json({ success: true, packages });
});

// Get or create the member's permanent ID.
async function getOrCreateMember(uid, email) {
  const memberRef = db.collection("members").doc(uid);
  const counterRef = db.collection("systemCounters").doc("members");

  return db.runTransaction(async transaction => {
    const memberSnap = await transaction.get(memberRef);

    if (memberSnap.exists && memberSnap.data().memberId) {
      return memberSnap.data().memberId;
    }

    const counterSnap = await transaction.get(counterRef);
    const lastNumber = counterSnap.exists
      ? Number(counterSnap.data().lastNumber || 0)
      : 0;

    const nextNumber = lastNumber + 1;
    const memberId = "BM" + String(nextNumber).padStart(4, "0");

    transaction.set(memberRef, {
      uid,
      email: email || "",
      memberId,
      status: memberSnap.exists
        ? (memberSnap.data().status || "pending")
        : "pending",
      createdAt: memberSnap.exists
        ? (memberSnap.data().createdAt || admin.firestore.FieldValue.serverTimestamp())
        : admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    transaction.set(counterRef, {
      lastNumber: nextNumber,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return memberId;
  });
}

app.post("/api/signup/initialize", requireUser, async (req, res) => {
  try {
    const memberId = await getOrCreateMember(
      req.user.uid,
      req.user.email
    );

    return res.json({
      success: true,
      memberId
    });
  } catch (error) {
    console.error("Signup initialize error:", error.message);
    return sendError(res, 500, "Could not initialize member account.");
  }
});

app.get("/api/member/me", requireUser, async (req, res) => {
  try {
    const memberRef = db.collection("members").doc(req.user.uid);
    const snap = await memberRef.get();

    if (!snap.exists) {
      return sendError(res, 404, "Member account not found.");
    }

    return res.json({
      success: true,
      member: snap.data()
    });
  } catch (error) {
    console.error("Member fetch error:", error.message);
    return sendError(res, 500, "Could not load member details.");
  }
});

// Create a Razorpay order.
app.post("/api/signup/create-order", requireUser, async (req, res) => {
  try {
    if (!razorpay) {
      return sendError(res, 503, "Razorpay keys are not configured on Render.");
    }

    const packageName = String(req.body.packageName || req.body.package || "");
    const amount = packages[packageName];

    if (!amount) {
      return sendError(res, 400, "Select a valid package.");
    }

    const memberId = await getOrCreateMember(
      req.user.uid,
      req.user.email
    );

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: "bm_" + crypto.randomBytes(8).toString("hex"),
      notes: {
        uid: req.user.uid,
        memberId,
        packageName
      }
    });

    await db.collection("signupOrders").doc(order.id).set({
      orderId: order.id,
      uid: req.user.uid,
      memberId,
      packageName,
      amount,
      currency: "INR",
      status: "created",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({
      success: true,
      keyId: razorpayKeyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      packageName,
      memberId
    });
  } catch (error) {
    console.error("Create order error:", error.message);
    return sendError(res, 500, "Could not create payment order.");
  }
});

// Verify Razorpay payment signature and activate membership.
app.post("/api/signup/complete", requireUser, async (req, res) => {
  try {
    if (!razorpayKeySecret) {
      return sendError(res, 503, "Razorpay is not configured.");
    }

    const {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature
    } = req.body;

    if (!orderId || !paymentId || !signature) {
      return sendError(res, 400, "Payment verification details are missing.");
    }

    const expectedSignature = crypto
      .createHmac("sha256", razorpayKeySecret)
      .update(orderId + "|" + paymentId)
      .digest("hex");

    const expected = Buffer.from(expectedSignature, "hex");
    const received = Buffer.from(String(signature), "hex");

    if (
      expected.length !== received.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      return sendError(res, 400, "Payment signature is invalid.");
    }

    const orderRef = db.collection("signupOrders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return sendError(res, 404, "Order not found.");
    }

    const orderData = orderSnap.data();

    if (orderData.uid !== req.user.uid) {
      return sendError(res, 403, "This order belongs to another account.");
    }

    // Prevent a second account from reusing a completed order.
    if (orderData.status === "paid") {
      return res.json({
        success: true,
        message: "Payment was already verified.",
        memberId: orderData.memberId
      });
    }

    // Fetch the payment from Razorpay to verify amount and status.
    const payment = await razorpay.payments.fetch(paymentId);

    if (
      payment.order_id !== orderId ||
      payment.amount !== orderData.amount * 100 ||
      payment.currency !== "INR" ||
      !["captured", "authorized"].includes(payment.status)
    ) {
      return sendError(res, 400, "Payment amount or status does not match.");
    }

    if (payment.status !== "captured") {
      return sendError(
        res,
        409,
        "Payment is authorized but not captured. Confirm capture in Razorpay."
      );
    }

    const memberRef = db.collection("members").doc(req.user.uid);
    const paymentRef = db.collection("payments").doc(paymentId);

    await db.runTransaction(async transaction => {
      const freshOrder = await transaction.get(orderRef);
      const freshPayment = await transaction.get(paymentRef);

      if (!freshOrder.exists) {
        throw new Error("ORDER_NOT_FOUND");
      }

      if (freshOrder.data().uid !== req.user.uid) {
        throw new Error("ORDER_OWNER_MISMATCH");
      }

      if (freshOrder.data().status === "paid") {
        return;
      }

      if (freshPayment.exists) {
        throw new Error("PAYMENT_ALREADY_USED");
      }

      transaction.set(paymentRef, {
        paymentId,
        orderId,
        uid: req.user.uid,
        memberId: orderData.memberId,
        packageName: orderData.packageName,
        amount: orderData.amount,
        currency: "INR",
        status: "captured",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      transaction.set(memberRef, {
        status: "active",
        packageName: orderData.packageName,
        packageAmount: orderData.amount,
        paymentId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      transaction.update(orderRef, {
        status: "paid",
        paymentId,
        paidAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.json({
      success: true,
      message: "Payment verified successfully.",
      memberId: orderData.memberId,
      packageName: orderData.packageName
    });
  } catch (error) {
    console.error("Payment completion error:", error.message);

    if (error.message === "PAYMENT_ALREADY_USED") {
      return sendError(res, 409, "This payment has already been used.");
    }

    return sendError(res, 500, "Could not verify payment.");
  }
});

// Handle unexpected errors without exposing secrets.
app.use((error, req, res, next) => {
  console.error("Backend request error:", error.message);

  if (error.message === "Origin not allowed by CORS") {
    return sendError(res, 403, "This website origin is not allowed.");
  }

  return sendError(res, 500, "Internal server error.");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Business Mindset backend running on port ${PORT}`);
});
