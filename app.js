require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth.routes');
const businessRoutes = require('./routes/business.routes');
const accountingRoutes = require('./routes/accounting.routes');
const gstRoutes = require('./routes/gst.routes');
const documentsRoutes = require('./routes/documents.routes');
const marketplaceRoutes = require('./routes/marketplace.routes');
const paymentsRoutes = require('./routes/payments.routes');
const subscriptionsRoutes = require('./routes/subscriptions.routes');
const adminRoutes = require('./routes/admin.routes');
const aiRoutes = require('./routes/ai.routes');
const walletRoutes = require('./routes/wallet.routes');
const creditsRoutes = require('./routes/credits.routes');

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '2mb' }));

// Generous global limit; tighten per-route (e.g. /auth/login) if you see abuse.
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 600 }));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/business', businessRoutes);
app.use('/api/accounting', accountingRoutes);
app.use('/api/gst', gstRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/marketplace', marketplaceRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/credits', creditsRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

module.exports = app;
