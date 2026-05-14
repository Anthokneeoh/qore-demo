const express = require('express');
const router = express.Router();
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const { getAIHint } = require('../services/aiService');
const { fireWebhook } = require('../services/webhookService');
const {
    getCustomers, createCustomer, getCustomerById,
    getAccounts, createAccount, getAccountById, updateAccountStatus,
    getTransfers, getTransferById, createTransfer, updateTransferStatus,
    getApiKeyByKey, checkIdempotency, storeIdempotency,
    getOrCreateAccountName, getWebhookUrl,
    getCustomerByBvn
} = require('../data/mockDb');

router.use(cookieParser());

router.use((req, res, next) => {
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
});

async function authenticate(req) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return null;
    const key = auth.split(' ')[1];
    if (!key.startsWith('sk_test_')) return null;
    const apiKey = await getApiKeyByKey(key);
    if (apiKey) req.sessionId = apiKey.session_id;
    return apiKey || null;
}

async function sendError(req, res, status, code, title, detail, field = null) {
    let aiHint = null;
    if (status >= 400 && status < 500) {
        try {
            aiHint = await getAIHint(code, field, detail, `${req.method} ${req.path}`);
        } catch (err) {
            console.error('[AI] Hint failed:', err);
            aiHint = "AI hint generation temporarily unavailable.";
        }
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

// ========== CUSTOMERS ==========
router.post('/customers', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Missing or invalid API key');

    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey)
        return sendError(req, res, 400, 'idempotency-key-required', 'Idempotency Key Required', 'Idempotency-Key header missing');

    let cached;
    try {
        cached = checkIdempotency(idempotencyKey, req.body || {});
    } catch (err) {
        if (err.message === 'IDEMPOTENCY_CONFLICT') {
            return sendError(req, res, 409, 'conflict', 'Idempotency Conflict',
                'This Idempotency-Key was already used with a different customer payload. Generate a new UUID for this request.');
        }
        throw err;
    }
    if (cached) return res.status(201).set('Idempotent-Replayed', 'true').json(cached);

    const { first_name, last_name, phone_number, email, bvn, date_of_birth, gender } = req.body || {};
    if (!first_name || !last_name || !phone_number || !email)
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'Missing required fields');

    if (!/^\+234\d{10}$/.test(phone_number))
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'Phone must be E.164: +234XXXXXXXXXX', 'phone_number');

    const ALLOWED_GENDERS = ['male', 'female', 'other', 'non-binary'];
    if (gender && !ALLOWED_GENDERS.includes(gender.toLowerCase())) {
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request',
            `Gender must be one of: ${ALLOWED_GENDERS.join(', ')}`, 'gender');
    }

    const existing = await getCustomers({ email });
    if (existing.length) return sendError(req, res, 409, 'conflict', 'Conflict', 'Email already registered', 'email');

    const existingPhone = await getCustomers({ phone: phone_number });
    if (existingPhone.length) return sendError(req, res, 409, 'conflict', 'Conflict', 'Phone already registered', 'phone_number');

    if (bvn && !/^\d{11}$/.test(bvn))
        return sendError(req, res, 422, 'unprocessable', 'Unprocessable', 'BVN must be 11 digits', 'bvn');

    if (bvn) {
        const existingByBvn = await getCustomerByBvn(bvn);
        if (existingByBvn) {
            return sendError(req, res, 409, 'conflict', 'Conflict',
                'BVN is already registered to another customer. BVN must be unique.', 'bvn');
        }
    }

    if (date_of_birth) {
        const birthDate = new Date(date_of_birth);
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        const monthDiff = today.getMonth() - birthDate.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) age--;

        if (isNaN(birthDate.getTime())) {
            return sendError(req, res, 400, 'invalid-request', 'Invalid Request',
                'Invalid date_of_birth format. Use YYYY-MM-DD.', 'date_of_birth');
        }
        if (birthDate > today) {
            return sendError(req, res, 400, 'invalid-request', 'Invalid Request',
                'Date of birth cannot be in the future.', 'date_of_birth');
        }
        if (age < 18) {
            return sendError(req, res, 400, 'invalid-request', 'Invalid Request',
                'Customer must be at least 18 years old.', 'date_of_birth');
        }
    }

    const newCustomer = {
        id: `cus_${uuidv4().slice(0, 8)}`,
        first_name, last_name, phone_number, email,
        kyc_tier: bvn ? 2 : 1,
        status: 'active',
        created_at: new Date().toISOString(),
        ...(date_of_birth && { date_of_birth }),
        ...(bvn && { bvn }),
        ...(gender && { gender })
    };

    let created;
    try {
        created = await createCustomer(newCustomer);
    } catch (err) {
        console.error('Supabase insert error:', err);
        return sendError(req, res, 500, 'internal-error', 'Internal Server Error', 'Failed to create customer. Check logs.');
    }

    storeIdempotency(idempotencyKey, req.body || {}, created);
    res.status(201).json(created);
});

router.get('/customers', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');

    const filters = {};
    if (req.query.email) filters.email = req.query.email;
    if (req.query.phone) filters.phone = req.query.phone;

    const data = await getCustomers(filters);
    res.json({ data, meta: { total_count: data.length, has_more: false } });
});

// ========== ACCOUNTS ==========
router.post('/accounts', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');

    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) return sendError(req, res, 400, 'idempotency-key-required', 'Idempotency Key Required', 'Idempotency-Key header missing');

    let cached;
    try {
        cached = checkIdempotency(idempotencyKey, req.body || {});
    } catch (err) {
        if (err.message === 'IDEMPOTENCY_CONFLICT') {
            return sendError(req, res, 409, 'conflict', 'Idempotency Conflict',
                'This Idempotency-Key was already used with a different account payload. Generate a new UUID for this request.');
        }
        throw err;
    }
    if (cached) return res.status(201).set('Idempotent-Replayed', 'true').json(cached);

    const { customer_id, product_code, currency = 'NGN' } = req.body || {};
    if (!customer_id || !product_code)
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'customer_id and product_code required');

    const customer = await getCustomerById(customer_id);
    if (!customer || !customer.id) return sendError(req, res, 404, 'not-found', 'Not Found', `Customer with id ${customer_id} does not exist`);

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
        status: customer.kyc_tier >= 2 ? 'active' : 'pending_activation',
        product_code,
        currency,
        created_at: new Date().toISOString()
    };

    let created;
    try {
        created = await createAccount(newAccount);

        if (created.status === 'active') {
            const sessionId = req.sessionId || req.cookies.session_id;
            const webhookUrl = await getWebhookUrl(sessionId);
            if (webhookUrl) {
                await fireWebhook('account.activated', {
                    account_id: created.id,
                    account_number: created.account_number,
                    status: 'active',
                    activated_at: new Date().toISOString()
                }, webhookUrl, sessionId);
            }
        }
    } catch (err) {
        console.error('Supabase insert account error:', err);
        return sendError(req, res, 500, 'internal-error', 'Internal Server Error', 'Failed to create account. Please try again.');
    }

    storeIdempotency(idempotencyKey, req.body || {}, created);
    res.status(201).json(created);
});

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

// ========== NAME ENQUIRY ==========
router.post('/transfers/name-enquiry', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');

    const { destination_bank_code, destination_account_number } = req.body || {};
    if (!destination_bank_code || !destination_account_number)
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'destination_bank_code and destination_account_number are required');

    if (!/^\d{10}$/.test(destination_account_number))
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'Account number must be 10 digits (NUBAN)');

    const knownBanks = {
        '044': 'Access Bank',
        '011': 'First Bank of Nigeria',
        '058': 'Guaranty Trust Bank (GTBank)',
        '033': 'United Bank for Africa (UBA)',
        '050': 'Ecobank Nigeria'
    };
    const bankName = knownBanks[destination_bank_code];
    if (!bankName)
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'Bank code not supported. Use GET /v1/banks to see supported codes');

    if (!destination_account_number.startsWith('123456')) {
        return sendError(req, res, 404, 'not-found', 'Account Not Found',
            'The specified account number was not found in the bank records. Please verify and try again.');
    }

    let accountName;
    try {
        accountName = await getOrCreateAccountName(destination_bank_code, destination_account_number);
    } catch (err) {
        console.error('[NameEnquiry] Failed to resolve name:', err);
        return sendError(req, res, 500, 'internal-error', 'Internal Server Error',
            'Could not verify account name. Please try again.');
    }

    res.json({
        account_name: accountName,
        bank_name: bankName,
        bank_code: destination_bank_code,
        account_number: destination_account_number,
        verified_at: new Date().toISOString()
    });
});

// ========== INTERBANK TRANSFERS ==========
router.post('/transfers', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');

    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) return sendError(req, res, 400, 'idempotency-key-required', 'Idempotency Key Required', 'Idempotency-Key header missing');

    let cached;
    try {
        cached = checkIdempotency(idempotencyKey, req.body || {});
    } catch (err) {
        if (err.message === 'IDEMPOTENCY_CONFLICT') {
            return sendError(req, res, 409, 'conflict', 'Idempotency Conflict',
                'This Idempotency-Key was already used with a different transfer payload. Generate a new UUID for this transfer.');
        }
        throw err;
    }
    if (cached) return res.status(202).set('Idempotent-Replayed', 'true').json(cached);

    const {
        source_account_id, destination_bank_code, destination_account_number,
        destination_account_name, amount, currency = 'NGN', narration, reference
    } = req.body || {};
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

    const sessionId = req.sessionId || req.cookies.session_id;
    const currentWebhookUrl = await getWebhookUrl(sessionId);
    const transferId = `trf_${uuidv4().slice(0, 8)}`;

    const success = Math.random() > 0.3;
    const finalStatus = success ? 'success' : 'failed';

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
        status: finalStatus,
        created_at: new Date().toISOString(),
        webhook_url: currentWebhookUrl || null
    };

    let created;
    try {
        created = await createTransfer(newTransfer);

        if (currentWebhookUrl) {
            if (success) {
                await fireWebhook('transfer.completed', {
                    transfer_id: transferId,
                    status: 'success',
                    amount: amountKobo,
                    currency,
                    nip_session_id: `0904${Date.now()}`,
                    settlement_reference: `STL-${Date.now()}`,
                    completed_at: new Date().toISOString()
                }, currentWebhookUrl, sessionId);
            } else {
                await fireWebhook('transfer.failed', {
                    transfer_id: transferId,
                    status: 'failed',
                    failure_reason: 'INSUFFICIENT_FUNDS',
                    refund_status: 'refunded',
                    refunded_at: new Date().toISOString()
                }, currentWebhookUrl, sessionId);
            }
        }
    } catch (err) {
        console.error('[Transfers] Supabase insert error:', err);
        return sendError(req, res, 500, 'internal-error', 'Internal Server Error', 'Failed to create transfer. Check logs.');
    }

    const responseBody = {
        transfer_id: transferId,
        status: finalStatus,
        amount: amountKobo,
        currency,
        source_account_id,
        created_at: created.created_at,
        estimated_settlement: new Date(Date.now() + 5000).toISOString()
    };

    storeIdempotency(idempotencyKey, req.body || {}, responseBody);
    res.status(201).json(responseBody);
});

router.get('/transfers', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');

    const filters = {};
    if (req.query.account_id) filters.source_account_id = req.query.account_id;
    if (req.query.status) filters.status = req.query.status;

    const data = await getTransfers(filters);
    res.json({ data, meta: { total_count: data.length, has_more: false } });
});

router.get('/transfers/:id', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');

    const transfer = await getTransferById(req.params.id);
    if (!transfer) return sendError(req, res, 404, 'not-found', 'Not Found', 'Transfer not found');

    res.json(transfer);
});

// ========== WALLET BALANCE ==========
router.get('/wallet-balance', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');

    const { account_id } = req.query;
    if (!account_id) return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'account_id required');
    if (!account_id.startsWith('acc_')) return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'account_id must start with acc_');

    const account = await getAccountById(account_id);
    if (!account) return sendError(req, res, 404, 'not-found', 'Not Found', 'Account not found');

    const customer = await getCustomerById(account.customer_id);
    const accountName = customer ? `${customer.first_name} ${customer.last_name}` : 'Unknown Customer';

    const transfersList = await getTransfers({ source_account_id: account_id });
    const totalDebits = transfersList.filter(t => t.status === 'success').reduce((sum, t) => sum + t.amount, 0);
    const SEED_BALANCE = 10000000;
    const available = SEED_BALANCE - totalDebits;

    res.json({
        account_id,
        account_number: account.account_number,
        account_name: accountName,
        currency: account.currency,
        available_balance: Math.max(0, available),
        ledger_balance: Math.max(0, available),
        available_balance_formatted: `NGN ${(Math.max(0, available) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`,
        queried_at: new Date().toISOString()
    });
});

// ========== INTERNAL TRANSFERS ==========
router.post('/transfers/internal', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');

    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) return sendError(req, res, 400, 'idempotency-key-required', 'Idempotency Key Required', 'Idempotency-Key header missing');

    let cached;
    try {
        cached = checkIdempotency(idempotencyKey, req.body || {});
    } catch (err) {
        if (err.message === 'IDEMPOTENCY_CONFLICT') {
            return sendError(req, res, 409, 'conflict', 'Idempotency Conflict',
                'This Idempotency-Key was already used with a different internal transfer payload. Generate a new UUID for this transfer.');
        }
        throw err;
    }
    if (cached) return res.status(201).set('Idempotent-Replayed', 'true').json(cached);

    const { source_account_id, destination_account_id, amount, currency = 'NGN', narration } = req.body || {};
    if (!source_account_id || !destination_account_id || !amount)
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'source_account_id, destination_account_id, and amount are required');

    if (source_account_id === destination_account_id)
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'Source and destination accounts cannot be the same');

    const sourceAccount = await getAccountById(source_account_id);
    if (!sourceAccount) return sendError(req, res, 404, 'not-found', 'Not Found', 'Source account not found');
    if (sourceAccount.status !== 'active')
        return sendError(req, res, 422, 'unprocessable', 'Unprocessable', 'Source account is not active');

    const destAccount = await getAccountById(destination_account_id);
    if (!destAccount) return sendError(req, res, 404, 'not-found', 'Not Found', 'Destination account not found');
    if (destAccount.status !== 'active')
        return sendError(req, res, 422, 'unprocessable', 'Unprocessable', 'Destination account is not active');

    const amountKobo = parseInt(amount);
    if (isNaN(amountKobo) || amountKobo <= 0)
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'Amount must be a positive integer in kobo');

    const outgoingTransfers = await getTransfers({ source_account_id });
    const totalOut = outgoingTransfers.filter(t => t.status === 'success').reduce((sum, t) => sum + t.amount, 0);
    const SEED_BALANCE = 10000000;
    const availableBalance = SEED_BALANCE - totalOut;

    if (availableBalance < amountKobo)
        return sendError(req, res, 422, 'unprocessable', 'Unprocessable', 'Insufficient funds');

    const sessionId = req.sessionId || req.cookies.session_id;
    const currentWebhookUrl = await getWebhookUrl(sessionId);
    const transferId = `trf_${uuidv4().slice(0, 8)}`;

    const newTransfer = {
        id: transferId,
        source_account_id,
        destination_account_id,
        amount: amountKobo,
        currency,
        narration: narration || null,
        status: 'success',
        created_at: new Date().toISOString(),
        webhook_url: currentWebhookUrl || null
    };

    let created;
    try {
        created = await createTransfer(newTransfer);
    } catch (err) {
        console.error('[Internal Transfer] Supabase insert error:', err);
        return sendError(req, res, 500, 'internal-error', 'Internal Server Error', 'Failed to create internal transfer.');
    }

    const destCustomer = await getCustomerById(destAccount.customer_id);

    const enrichedResponse = {
        id: created.id,
        source_account_id: created.source_account_id,
        destination_account_id: created.destination_account_id,
        destination_account_number: destAccount.account_number,
        destination_customer_name: destCustomer ? `${destCustomer.first_name} ${destCustomer.last_name}` : null,
        destination_bank: 'Qore Bank',
        amount: created.amount,
        currency: created.currency,
        narration: created.narration,
        status: created.status,
        created_at: created.created_at,
        webhook_url: created.webhook_url
    };

    storeIdempotency(idempotencyKey, req.body || {}, enrichedResponse);

    if (currentWebhookUrl) {
        try {
            await fireWebhook('transfer.completed', {
                transfer_id: transferId,
                status: 'success',
                amount: amountKobo,
                currency,
                destination_account_id: destination_account_id,
                destination_account_number: destAccount.account_number,
                destination_customer_name: destCustomer ? `${destCustomer.first_name} ${destCustomer.last_name}` : null,
                settlement_reference: `INT-${Date.now()}`,
                completed_at: new Date().toISOString()
            }, currentWebhookUrl, sessionId);
        } catch (err) {
            console.error('[Internal Transfer] Webhook failed:', err);
        }
    }

    res.status(201).json(enrichedResponse);
});

// ========== TRANSACTION HISTORY ==========
router.get('/transactions', async (req, res) => {
    const auth = await authenticate(req);
    if (!auth) return sendError(req, res, 401, 'unauthorized', 'Unauthorized', 'Invalid API key');

    const { account_id } = req.query;
    if (!account_id) return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'account_id query parameter is required');

    if (!account_id.startsWith('acc_')) {
        return sendError(req, res, 400, 'invalid-request', 'Invalid Request', 'account_id must start with acc_ (e.g., acc_12345678)');
    }

    const { data, error } = await require('../data/supabaseClient')
        .from('transfers')
        .select('*')
        .or(`source_account_id.eq.${account_id},destination_account_id.eq.${account_id}`)
        .order('created_at', { ascending: false });

    if (error) throw error;

    const enriched = await Promise.all((data || []).map(async t => {
        let destName = t.destination_account_name;
        let destBank = t.destination_bank_code || t.destination_bank;
        let destAcctNum = t.destination_account_number;

        if (t.destination_account_id) {
            destBank = "000 (Qore Bank)";
            const destAccount = await getAccountById(t.destination_account_id);
            if (destAccount) {
                destAcctNum = destAccount.account_number;
                const destCustomer = await getCustomerById(destAccount.customer_id);
                if (destCustomer) {
                    destName = `${destCustomer.first_name} ${destCustomer.last_name}`;
                }
            }
        }

        return {
            ...t,
            destination_bank_code: destBank,
            destination_account_number: destAcctNum,
            destination_account_name: destName,
            direction: t.source_account_id === account_id ? 'outgoing' : 'incoming'
        };
    }));

    res.json({ data: enriched, meta: { total_count: enriched.length, has_more: false } });
});

module.exports = router;