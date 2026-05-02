const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const {
    getCustomers, getAccounts, getTransfers, getApiKeys,
    updateApiKey, getWebhookUrl, setWebhookUrl
} = require('../data/mockDb');
const { deliveryLog, resendWebhook } = require('../services/webhookService');

// Demo auth 
function isDemoAuth(req, res, next) {
    next();
}

// ── Login pages ────────────────────────────────────────────────────────────
router.get('/login', (req, res) => res.render('signup'));

router.post('/login', (req, res) => {
    res.cookie('demo_auth', '1', { maxAge: 86400000 });
    res.redirect('/dashboard');
});

router.get('/', isDemoAuth, async (req, res) => {
    try {
        const customers = await getCustomers();
        const accounts = await getAccounts();
        const transfers = await getTransfers();
        const apiKeys = await getApiKeys();
        const webhookUrl = await getWebhookUrl();

        console.log('API keys from Supabase:', apiKeys);
        res.render('dashboard', {
            customers,
            accounts,
            transfers,
            apiKeys,
            webhookUrl: webhookUrl || '',
            webhookLog: deliveryLog.slice(-20).reverse(),
            query: req.query
        });
    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).send('Failed to load dashboard – check Supabase connection');
    }
});

router.post('/generate-key', isDemoAuth, async (req, res) => {
    const newKey = `sk_test_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    await updateApiKey('sk_test_demo123abc', newKey, 'test');
    res.redirect('/dashboard');
});

router.post('/webhook', isDemoAuth, async (req, res) => {
    const { url } = req.body;
    if (!url || !url.startsWith('http')) {
        return res.redirect('/dashboard?error=invalid_url');
    }
    await setWebhookUrl(url);
    res.redirect('/dashboard?saved=1');
});

// ── Resend a webhook by ID (from deliveryLog) ──────────────────────────────
router.post('/resend-webhook/:webhookId', isDemoAuth, async (req, res) => {
    const result = await resendWebhook(req.params.webhookId);
    if (result.success) {
        res.redirect('/dashboard?resent=1');
    } else {
        res.redirect(`/dashboard?resend_error=${encodeURIComponent(result.error)}`);
    }
});

module.exports = router;