const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getAIHint } = require('../services/aiService');
const { fireWebhook } = require('../services/webhookService');
const {
    getCustomers, createCustomer, getCustomerById,
    getAccounts, createAccount, getAccountById, updateAccountStatus,
    getTransfers, getTransferById, createTransfer, updateTransferStatus,
    getApiKeyByKey, checkIdempotency, storeIdempotency
} = require('../data/mockDb');

async function authenticate(req) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return null;

    const key = auth.split(' ')[1];
    if (!key.startsWith('sk_test_')) return null;

    const apiKey = await getApiKeyByKey(key);
    return apiKey || null;
}

// Error helper
async function sendError(req, res, status, code, title, detail, field = null) {
    let aiHint = null;
    if (status >= 400 && status < 500) {
        aiHint = await getAIHint(code, field, `${req.method} ${req.path}`);
    }
    res.status(status).json({
        type: `https://api.qore.dev/errors/${code}`,
        title,
        status,
        detail,
        instance: req.path,
        request_id: uuidv4(),
        timestamp: new Date().toISOString(),
        ...(field && { field }),
        ...(aiHint && { ai_hint: aiHint })
    });
}

// POST /v1/customers
router.post('/customers', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Missing or invalid API key');

    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey)
        return sendError(req, res, 400, 'idempotency-key-required', 'Idempotency Key Required', 'Idempotency-Key header missing');

    const cached = checkIdempotency(idempotencyKey);
    if (cached) return res.status(201).set('Idempotent-Replayed', 'true').json(cached);

    const { first_name, last_name, phone_number, email, bvn, date_of_birth } = req.body;
    if (!first_name || !last_name || !phone_number || !email)
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'Missing required fields');

    if (!/^\+234\d{10}$/.test(phone_number))
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'Phone must be E.164: +234XXXXXXXXXX', 'phone_number');

    const existing = await getCustomers({ email });
    if (existing.length) return sendError(req, res, 409, 'conflict', 'Conflict', 'Email already registered');

    const existingPhone = await getCustomers({ phone: phone_number });
    if (existingPhone.length) return sendError(req, res, 409, 'conflict', 'Conflict', 'Phone already registered', 'phone_number');

    if (bvn && !/^\d{11}$/.test(bvn))
        return sendError(req, res, 422, 'unprocessable', 'Unprocessable', 'BVN must be 11 digits', 'bvn');

    const newCustomer = {
        id: `cus_${uuidv4().slice(0, 8)}`,
        first_name, last_name, phone_number, email,
        kyc_tier: bvn ? 2 : 1,
        status: 'active',
        created_at: new Date().toISOString(),
        ...(date_of_birth && { date_of_birth })
    };
    const created = await createCustomer(newCustomer);
    storeIdempotency(idempotencyKey, created);
    res.status(201).json(created);
});

// GET /v1/customers
router.get('/customers', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');
    const filters = {};
    if (req.query.email) filters.email = req.query.email;
    if (req.query.phone) filters.phone = req.query.phone;
    const data = await getCustomers(filters);
    res.json({ data, meta: { total_count: data.length, has_more: false } });
});

// POST /v1/accounts
router.post('/accounts', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');

    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) return sendError(req, res, 400, 'idempotency-key-required', 'Idempotency Key Required', 'Idempotency-Key header missing');

    const cached = checkIdempotency(idempotencyKey);
    if (cached) return res.status(201).set('Idempotent-Replayed', 'true').json(cached);

    const { customer_id, product_code, currency = 'NGN' } = req.body;
    if (!customer_id || !product_code)
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'customer_id and product_code required');

    const customer = await getCustomerById(customer_id);
    if (!customer) return sendError(req, res, 404, 'not-found', 'Not Found', 'Customer not found', 'customer_id');

    const existingAccounts = await getAccounts({ customer_id });
    if (existingAccounts.some(a => a.product_code === product_code))
        return sendError(req, res, 409, 'conflict', 'Conflict', 'Customer already has this product');

    const VALID_PRODUCTS = ['SAVINGS_BASIC', 'CURRENT', 'SAVINGS_PREMIUM'];
    if (!VALID_PRODUCTS.includes(product_code))
        return sendError(req, res, 422, 'unprocessable', 'Unprocessable', `Invalid product_code`);

    const accountNumber = Math.floor(1000000000 + Math.random() * 9000000000).toString();
    const newAccount = {
        id: `acc_${uuidv4().slice(0, 8)}`,
        account_number: accountNumber,
        customer_id,
        status: 'pending_activation',
        product_code,
        currency,
        created_at: new Date().toISOString()
    };
    const created = await createAccount(newAccount);
    storeIdempotency(idempotencyKey, created);

    // Simulate activation after 4s if KYC tier >=2
    if (customer.kyc_tier >= 2) {
        setTimeout(async () => {
            await updateAccountStatus(created.id, 'active', { activated_at: new Date().toISOString() });

            await fireWebhook('account.activated', {
                account_id: created.id,
                account_number: created.account_number,
                status: 'active',
                activated_at: new Date().toISOString()
            }, auth.session_id);
        }, 4000);
    }
    res.status(201).json(created);
});

// GET /v1/banks
router.get('/banks', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');

    const banks = [
        { code: '044', name: 'Access Bank' },
        { code: '011', name: 'First Bank of Nigeria' },
        { code: '058', name: 'Guaranty Trust Bank (GTBank)' },
        { code: '033', name: 'United Bank for Africa (UBA)' },
        { code: '050', name: 'Ecobank Nigeria' }
    ];
    res.json({ banks });
});

// POST /v1/transfers/name-enquiry
router.post('/transfers/name-enquiry', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');
    const { destination_bank_code, destination_account_number } = req.body;
    if (!destination_bank_code || !destination_account_number)
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'Missing fields');
    const MOCK_NAMES = ['Adeola Ogunlesi', 'Ngozi Adeyemi', 'Emeka Okafor'];
    const MOCK_BANKS = { '044': 'Access Bank', '011': 'First Bank', '058': 'GTBank' };
    res.json({
        account_name: MOCK_NAMES[Math.floor(Math.random() * MOCK_NAMES.length)],
        bank_name: MOCK_BANKS[destination_bank_code] || 'Unknown Bank',
        bank_code: destination_bank_code,
        account_number: destination_account_number,
        verified_at: new Date().toISOString()
    });
});

// POST /v1/transfers
router.post('/transfers', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');

    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) return sendError(req, res, 400, 'idempotency-key-required', 'Idempotency Key Required', 'Idempotency-Key header missing');

    const cached = checkIdempotency(idempotencyKey);
    if (cached) return res.status(202).set('Idempotent-Replayed', 'true').json(cached);

    const {
        source_account_id, destination_bank_code, destination_account_number,
        destination_account_name, amount, currency = 'NGN', narration, reference
    } = req.body;
    if (!source_account_id || !destination_bank_code || !destination_account_number || !destination_account_name || !amount)
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'Missing required fields');

    const sourceAccount = await getAccountById(source_account_id);
    if (!sourceAccount) return sendError(req, res, 404, 'not-found', 'Not Found', 'Source account not found');
    if (sourceAccount.status !== 'active')
        return sendError(req, res, 422, 'unprocessable', 'Unprocessable', 'Source account not active');

    const amountKobo = parseInt(amount);
    if (isNaN(amountKobo) || amountKobo <= 0)
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'Amount must be positive integer (kobo)');

    if (!/^\d{10}$/.test(destination_account_number))
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'Destination account must be 10-digit NUBAN');

    const transferId = `trf_${uuidv4().slice(0, 8)}`;
    const newTransfer = {
        id: transferId,
        source_account_id,
        destination_bank_code,
        destination_account_number,
        destination_account_name,
        amount: amountKobo,
        currency,
        narration: narration || null,
        reference: reference || null,
        status: 'queued',
        created_at: new Date().toISOString()
    };
    const created = await createTransfer(newTransfer);
    const responseBody = {
        transfer_id: transferId,
        status: 'processing',
        amount: amountKobo,
        currency,
        source_account_id,
        created_at: created.created_at,
        estimated_settlement: new Date(Date.now() + 5000).toISOString()
    };
    storeIdempotency(idempotencyKey, responseBody);

    // Process asynchronously
    setTimeout(async () => {
        const success = Math.random() > 0.3;
        if (success) {
            await updateTransferStatus(transferId, 'success', { settlement_reference: `STL-${Date.now()}` });

            await fireWebhook('transfer.completed', {
                transfer_id: transferId,
                status: 'success',
                amount: amountKobo,
                currency,
                nip_session_id: `0904${Date.now()}`,
                settlement_reference: `STL-${Date.now()}`,
                completed_at: new Date().toISOString()
            }, auth.session_id);

        } else {
            await updateTransferStatus(transferId, 'failed', { failure_reason: 'INSUFFICIENT_FUNDS', refund_status: 'refunded', refunded_at: new Date().toISOString() });

            await fireWebhook('transfer.failed', {
                transfer_id: transferId,
                status: 'failed',
                failure_reason: 'INSUFFICIENT_FUNDS',
                refund_status: 'refunded',
                refunded_at: new Date().toISOString()
            }, auth.session_id);
        }
    }, 3000);

    res.status(202).json(responseBody);
});

// GET /v1/transfers (list)
router.get('/transfers', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');
    const filters = {};
    if (req.query.account_id) filters.source_account_id = req.query.account_id;
    if (req.query.status) filters.status = req.query.status;
    const data = await getTransfers(filters);
    res.json({ data, meta: { total_count: data.length, has_more: false } });
});

// GET /v1/transfers/:id (single)
router.get('/transfers/:id', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');
    const transfer = await getTransferById(req.params.id);
    if (!transfer) return sendError(req, res, 404, 'not-found', 'Not Found', 'Transfer not found');
    res.json(transfer);
});

// GET /v1/wallet-balance
router.get('/wallet-balance', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');
    const { account_id } = req.query;
    if (!account_id) return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'account_id required');
    const account = await getAccountById(account_id);
    if (!account) return sendError(req, res, 404, 'not-found', 'Not Found', 'Account not found');
    // Calculate balance from transfers
    const transfersList = await getTransfers({ source_account_id: account_id });
    const totalDebits = transfersList.filter(t => t.status === 'success').reduce((sum, t) => sum + t.amount, 0);
    const SEED_BALANCE = 10000000; // NGN 100,000 in kobo
    const available = SEED_BALANCE - totalDebits;
    res.json({
        account_id,
        account_number: account.account_number,
        currency: account.currency,
        available_balance: Math.max(0, available),
        ledger_balance: Math.max(0, available),
        available_balance_formatted: `NGN ${(Math.max(0, available) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`,
        queried_at: new Date().toISOString()
    });
});

module.exports = router;