const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { getWebhookUrl } = require('../data/mockDb');

const deliveryLog = [];
const MAX_LOG_SIZE = 1000;

async function fireWebhook(event, payload, sessionId) {
    if (!sessionId) {
        console.error('[Webhook] Missing sessionId — aborting delivery');
        return;
    }

    const webhookUrl = await getWebhookUrl(sessionId);

    if (!webhookUrl) {
        console.log(`[Webhook] No URL for session ${sessionId} — skipping`);
        return;
    }

    const webhookId = `wh_${uuidv4().slice(0, 8)}`;

    const body = {
        event,
        webhook_id: webhookId,
        timestamp: new Date().toISOString(),
        signature: `sha256=${uuidv4().replace(/-/g, '')}`,
        data: payload
    };

    const logEntry = {
        webhookId,
        event,
        url: webhookUrl,
        payload: body,
        status: 'pending',
        attemptedAt: new Date().toISOString(),
        transferId: payload.transfer_id ?? payload.id ?? null,
        session_id: sessionId
    };

    try {
        await axios.post(webhookUrl, body, { timeout: 8000 });
        logEntry.status = 'delivered';
        console.log(`[Webhook] Delivered ${event}`);
    } catch (err) {
        logEntry.status = 'failed';
        logEntry.error = err.message;
        console.error(`[Webhook] Failed ${event}: ${err.message}`);
    }

    deliveryLog.push(logEntry);

    // Prevent memory leak
    if (deliveryLog.length > MAX_LOG_SIZE) {
        deliveryLog.shift();
    }
}

async function resendWebhook(webhookId) {
    const entry = deliveryLog.find(l => l.webhookId === webhookId);
    if (!entry) return { success: false, error: 'Webhook not found' };

    try {
        await axios.post(entry.url, entry.payload, { timeout: 8000 });
        entry.status = 'delivered';
        entry.retriedAt = new Date().toISOString();
        return { success: true };
    } catch (err) {
        entry.status = 'failed';
        entry.error = err.message;
        return { success: false, error: err.message };
    }
}

module.exports = { fireWebhook, resendWebhook, deliveryLog };