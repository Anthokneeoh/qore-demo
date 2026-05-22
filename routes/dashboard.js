const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');

const {
    getApiKeys,
    getWebhookUrl,
    setWebhookUrl
} = require('../data/mockDb');
const supabase = require('../data/supabaseClient');
const { deliveryLog, resendWebhook } = require('../services/webhookService');

// Middleware Setup
router.use(cookieParser());
router.use(express.urlencoded({ extended: true }));
router.use(express.json());

// Session Management Middleware
function ensureSession(req, res, next) {
    if (!req.cookies.session_id) {
        const newSessionId = uuidv4();
        res.cookie('session_id', newSessionId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
        });
        req.cookies.session_id = newSessionId;
    }
    next();
}

router.use(ensureSession);

// Demo Authentication Middleware
function isDemoAuth(req, res, next) {
    next();
}

// Routes
router.get('/login', (req, res) => res.render('signup'));

router.post('/login', (req, res) => {
    res.cookie('demo_auth', '1', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 86400000 // 1 day
    });
    res.redirect('/dashboard');
});

// Main Dashboard Route
router.get('/', isDemoAuth, async (req, res) => {
    try {
        const sessionId = req.cookies.session_id;

        // Customers pagination
        const cPage  = Math.max(1, parseInt(req.query.cpage)  || 1);
        const cLimit = Math.min(100, Math.max(1, parseInt(req.query.climit) || 20));
        const cFrom  = (cPage - 1) * cLimit;
        const cTo    = cFrom + cLimit - 1;

        const { data: customers, count: cCount } = await supabase
            .from('customers')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(cFrom, cTo);

        // Accounts pagination
        const aPage  = Math.max(1, parseInt(req.query.apage)  || 1);
        const aLimit = Math.min(100, Math.max(1, parseInt(req.query.alimit) || 20));
        const aFrom  = (aPage - 1) * aLimit;
        const aTo    = aFrom + aLimit - 1;

        const { data: accounts, count: aCount } = await supabase
            .from('accounts')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(aFrom, aTo);

        // Transfers pagination
        const tPage  = Math.max(1, parseInt(req.query.tpage)  || 1);
        const tLimit = Math.min(100, Math.max(1, parseInt(req.query.tlimit) || 20));
        const tFrom  = (tPage - 1) * tLimit;
        const tTo    = tFrom + tLimit - 1;

        const { data: transfers, count: tCount } = await supabase
            .from('transfers')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(tFrom, tTo);

        // Fetch core session-specific data
        const apiKeys = await getApiKeys(sessionId);
        const webhookUrl = await getWebhookUrl(sessionId);

        // Filter webhook logs securely for the active session
        const safeWebhookLog = (deliveryLog || [])
            .filter(log => log && typeof log === 'object' && log.session_id === sessionId)
            .slice(-20)
            .reverse();

        res.render('dashboard', {
            customers:   customers || [],
            accounts:    accounts  || [],
            transfers:   transfers || [],
            apiKeys,
            webhookUrl:  webhookUrl || '',
            webhookLog:  safeWebhookLog,
            // pagination metadata
            cPage, cLimit, cCount: cCount || 0,
            aPage, aLimit, aCount: aCount || 0,
            tPage, tLimit, tCount: tCount || 0,
            // pass current query string through for page navigation links
            query: req.query
        });
    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).send('Failed to load dashboard – check Supabase connection');
    }
});

// Generate Test API Key
router.post('/generate-key', isDemoAuth, async (req, res) => {
    try {
        const sessionId = req.cookies.session_id;
        const newKey = `sk_test_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

        await updateApiKey(sessionId, 'test', newKey);
        res.redirect('/dashboard?tab=developer&key_updated=1');
    } catch (err) {
        console.error('Generate key error:', err);
        res.redirect('/dashboard?tab=developer&error=key_generation_failed');
    }
});

// Save Webhook URL
router.post('/webhook', isDemoAuth, async (req, res) => {
    try {
        const sessionId = req.cookies.session_id;
        const { url } = req.body;

        try {
            new URL(url);
        } catch {
            return res.redirect('/dashboard?tab=webhooks&error=invalid_url');
        }

        await setWebhookUrl(sessionId, url);
        res.redirect('/dashboard?tab=webhooks&saved=1');
    } catch (err) {
        console.error('Webhook save error:', err);
        res.redirect('/dashboard?tab=webhooks&error=webhook_save_failed');
    }
});

// Resend Webhook Payload
router.post('/resend-webhook/:webhookId', isDemoAuth, async (req, res) => {
    try {
        const result = await resendWebhook(req.params.webhookId);

        if (result.success) {
            res.redirect('/dashboard?tab=webhooks&resent=1');
        } else {
            res.redirect(`/dashboard?tab=webhooks&resend_error=${encodeURIComponent(result.error)}`);
        }
    } catch (err) {
        console.error('Resend webhook error:', err);
        res.redirect('/dashboard?tab=webhooks&error=resend_failed');
    }
});

// Import updateApiKey from mockDb for generate-key route
const { updateApiKey } = require('../data/mockDb');

module.exports = router;
