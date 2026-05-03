const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');
const {
    getCustomers, getAccounts, getTransfers, getApiKeys,
    updateApiKey, getWebhookUrl, setWebhookUrl
} = require('../data/mockDb');
const { deliveryLog, resendWebhook } = require('../services/webhookService');

router.use(cookieParser());
router.use(express.urlencoded({ extended: true }));
router.use(express.json());

// Middleware to ensure a secure session_id exists for isolation
function ensureSession(req, res, next) {
    if (!req.cookies.session_id) {
        const newSessionId = uuidv4();
        res.cookie('session_id', newSessionId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 30 * 24 * 60 * 60 * 1000
        });
        req.cookies.session_id = newSessionId;
    }
    next();
}

router.use(ensureSession);

// Demo-only auth 
function isDemoAuth(req, res, next) {
    next();
}

router.get('/login', (req, res) => res.render('signup'));

router.post('/login', (req, res) => {
    res.cookie('demo_auth', '1', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 86400000
    });
    res.redirect('/dashboard');
});

router.get('/', isDemoAuth, async (req, res) => {
    try {
        const sessionId = req.cookies.session_id;
        const customers = await getCustomers();
        const accounts = await getAccounts();
        const transfers = await getTransfers();
        const apiKeys = await getApiKeys(sessionId);
        const webhookUrl = await getWebhookUrl(sessionId);

        res.render('dashboard', {
            customers,
            accounts,
            transfers,
            apiKeys,
            webhookUrl: webhookUrl || '',
            webhookLog: deliveryLog
                .filter(log => log.session_id === sessionId)
                .slice(-20)
                .reverse(),
            query: req.query
        });
    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).send('Failed to load dashboard – check Supabase connection');
    }
});

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

module.exports = router;