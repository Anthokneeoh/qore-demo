const supabase = require('./supabaseClient');
const { v4: uuidv4 } = require('uuid');
const NodeCache = require('node-cache');
const crypto = require('crypto');

const cache = new NodeCache({ stdTTL: 60 });

function clearCacheByPrefix(prefix) {
    const keys = cache.keys();
    keys.forEach(k => {
        if (k.startsWith(prefix)) cache.del(k);
    });
}

function sortedStringify(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(sortedStringify).join(',') + ']';
    const keys = Object.keys(obj).sort();
    const sortedObj = {};
    for (const key of keys) {
        sortedObj[key] = sortedStringify(obj[key]);
    }
    return JSON.stringify(sortedObj);
}

function getRequestHash(body) {
    const sortedStr = sortedStringify(body);
    return crypto.createHash('sha256').update(sortedStr).digest('hex');
}

const idempotencyCache = new Map();

function checkIdempotency(key, requestBody) {
    const cached = idempotencyCache.get(key);
    if (!cached) return null;

    if (Date.now() > cached.expiresAt) {
        idempotencyCache.delete(key);
        return null;
    }

    const currentHash = getRequestHash(requestBody);
    if (cached.requestHash !== currentHash) {
        throw new Error('IDEMPOTENCY_CONFLICT');
    }
    return cached.response;
}

function storeIdempotency(key, requestBody, response) {
    const requestHash = getRequestHash(requestBody);
    idempotencyCache.set(key, {
        response,
        requestHash,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000
    });
}

async function getOrCreateAccountName(bankCode, accountNumber) {
    const normalizedBankCode = String(bankCode).trim();
    const normalizedAccountNumber = String(accountNumber).trim();
    const { data: existing, error: fetchError } = await supabase
        .from('mock_name_enquiries')
        .select('account_name')
        .eq('bank_code', normalizedBankCode)
        .eq('account_number', normalizedAccountNumber)
        .maybeSingle();

    if (fetchError) {
        console.error('[NameEnquiry] Fetch error:', fetchError);
        throw fetchError;
    }

    if (existing) {
        return existing.account_name;
    }
    const hash = crypto.createHash('md5')
        .update(`${normalizedBankCode}:${normalizedAccountNumber}`)
        .digest('hex');
    const mockNames = [
        'Adeola Ogunlesi', 'Ngozi Adeyemi', 'Emeka Okafor',
        'Fatima Al-Hassan', 'Chukwuemeka Eze'
    ];
    const index = parseInt(hash.slice(0, 8), 16) % mockNames.length;
    const accountName = mockNames[index];
    const { error: insertError } = await supabase
        .from('mock_name_enquiries')
        .upsert([{
            bank_code: normalizedBankCode,
            account_number: normalizedAccountNumber,
            account_name: accountName,
            created_at: new Date().toISOString()
        }], {
            onConflict: 'bank_code,account_number'
        });

    if (insertError) {
        console.error('[NameEnquiry] Insert error:', insertError);
        const { data: retryData, error: retryError } = await supabase
            .from('mock_name_enquiries')
            .select('account_name')
            .eq('bank_code', normalizedBankCode)
            .eq('account_number', normalizedAccountNumber)
            .maybeSingle();
        if (retryError) throw retryError;
        if (retryData) return retryData.account_name;
        throw insertError;
    }

    return accountName;
}

async function getCustomers(filters = {}) {
    const cacheKey = `customers_${JSON.stringify(filters)}`;
    let cached = cache.get(cacheKey);
    if (cached) return cached;

    let query = supabase.from('customers').select('*');
    if (filters.email) query = query.eq('email', filters.email);
    if (filters.phone) query = query.eq('phone_number', filters.phone);

    const { data, error } = await query;

    if (error) throw error;
    cache.set(cacheKey, data || []);
    return data || [];
}

async function createCustomer(customerData) {
    const { data, error } = await supabase
        .from('customers')
        .insert([customerData])
        .select();

    if (error) throw error;

    clearCacheByPrefix('customers_');
    return data?.[0] || null;
}

async function getCustomerById(id) {
    const { data, error } = await supabase
        .from('customers')
        .select('*')
        .eq('id', id)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
}

async function getAccounts(filters = {}) {
    const cacheKey = `accounts_${JSON.stringify(filters)}`;
    let cached = cache.get(cacheKey);
    if (cached) return cached;

    let query = supabase.from('accounts').select('*');
    if (filters.customer_id) query = query.eq('customer_id', filters.customer_id);
    if (filters.product_code) query = query.eq('product_code', filters.product_code);

    const { data, error } = await query;

    if (error) throw error;
    cache.set(cacheKey, data || []);
    return data || [];
}

async function createAccount(accountData) {
    const { data, error } = await supabase
        .from('accounts')
        .insert([accountData])
        .select();

    if (error) throw error;

    clearCacheByPrefix('accounts_');
    return data?.[0] || null;
}

async function getAccountById(id) {
    const { data, error } = await supabase
        .from('accounts')
        .select('*')
        .eq('id', id)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
}

async function updateAccountStatus(id, status, updatedFields = {}) {
    const { data, error } = await supabase
        .from('accounts')
        .update({ status, ...updatedFields })
        .eq('id', id)
        .select();

    if (error) throw error;

    clearCacheByPrefix('accounts_');
    return data?.[0] || null;
}

async function getTransfers(filters = {}) {
    const cacheKey = `transfers_${JSON.stringify(filters)}`;
    let cached = cache.get(cacheKey);
    if (cached) return cached;

    let query = supabase.from('transfers').select('*');
    if (filters.source_account_id) query = query.eq('source_account_id', filters.source_account_id);
    if (filters.status) query = query.eq('status', filters.status);

    const { data, error } = await query;

    if (error) throw error;
    cache.set(cacheKey, data || []);
    return data || [];
}

async function getTransferById(id) {
    const { data, error } = await supabase
        .from('transfers')
        .select('*')
        .eq('id', id)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
}

async function createTransfer(transferData) {
    const { data, error } = await supabase
        .from('transfers')
        .insert([transferData])
        .select();

    if (error) throw error;

    clearCacheByPrefix('transfers_');
    return data?.[0] || null;
}

async function updateTransferStatus(id, status, additionalFields = {}) {
    const { data, error } = await supabase
        .from('transfers')
        .update({
            status,
            ...additionalFields,
            completed_at: new Date().toISOString()
        })
        .eq('id', id)
        .select();

    if (error) throw error;

    clearCacheByPrefix('transfers_');
    return data?.[0] || null;
}

async function getApiKeys(sessionId) {
    const cacheKey = `api_keys_${sessionId}`;
    let cached = cache.get(cacheKey);
    if (cached) return cached;

    const { data, error } = await supabase
        .from('api_keys')
        .select('*')
        .eq('session_id', sessionId);

    if (error) throw error;

    if (!data || data.length === 0) {
        const defaultTest = `sk_test_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
        const defaultLive = `sk_live_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

        await supabase.from('api_keys').insert([
            {
                key: defaultTest,
                type: 'test',
                session_id: sessionId,
                label: 'Test key',
                institution: 'Qore Bank',
                created_at: new Date().toISOString()
            },
            {
                key: defaultLive,
                type: 'live',
                session_id: sessionId,
                label: 'Live key (inactive in sandbox)',
                institution: 'Qore Bank',
                created_at: new Date().toISOString()
            }
        ]);

        const { data: newData } = await supabase
            .from('api_keys')
            .select('*')
            .eq('session_id', sessionId);

        cache.set(cacheKey, newData);
        return newData;
    }

    cache.set(cacheKey, data);
    return data;
}

async function updateApiKey(sessionId, type, newKey) {
    const { error: deleteError } = await supabase
        .from('api_keys')
        .delete()
        .eq('session_id', sessionId)
        .eq('type', type);

    if (deleteError) throw deleteError;

    const { data, error } = await supabase
        .from('api_keys')
        .insert([{
            key: newKey,
            type,
            session_id: sessionId,
            label: type === 'test' ? 'Test key' : 'Live key (inactive in sandbox)',
            institution: 'Qore Bank',
            created_at: new Date().toISOString()
        }])
        .select();

    if (error) throw error;

    cache.del(`api_keys_${sessionId}`);
    return data?.[0] || null;
}

async function getApiKeyByKey(key) {
    const cacheKey = `api_key_lookup_${key}`;
    let cached = cache.get(cacheKey);
    if (cached) return cached;

    const { data, error } = await supabase
        .from('api_keys')
        .select('*')
        .eq('key', key)
        .limit(1)
        .single();

    if (error && error.code !== 'PGRST116') throw error;

    cache.set(cacheKey, data || null);
    return data || null;
}

async function getWebhookUrl(sessionId) {
    const cacheKey = `webhook_${sessionId}`;
    let cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const { data, error } = await supabase
        .from('webhook_urls')
        .select('url')
        .eq('session_id', sessionId)
        .limit(1)
        .single();

    if (error && error.code !== 'PGRST116') throw error;

    const url = data?.url || null;
    cache.set(cacheKey, url);
    return url;
}

async function setWebhookUrl(sessionId, url) {
    const { error: deleteError } = await supabase
        .from('webhook_urls')
        .delete()
        .eq('session_id', sessionId);

    if (deleteError) throw deleteError;

    const { data, error } = await supabase
        .from('webhook_urls')
        .insert([{
            url,
            session_id: sessionId,
            created_at: new Date().toISOString()
        }])
        .select();

    if (error) throw error;

    cache.del(`webhook_${sessionId}`);
    return data?.[0] || null;
}

async function getCustomerByBvn(bvn) {
    if (!bvn) return null;
    const { data, error } = await supabase
        .from('customers')
        .select('id')
        .eq('bvn', bvn)
        .limit(1);
    if (error) throw error;
    return data?.[0] || null;
}

module.exports = {
    getCustomers,
    createCustomer,
    getCustomerById,
    getAccounts,
    createAccount,
    getAccountById,
    updateAccountStatus,
    getTransfers,
    getTransferById,
    createTransfer,
    updateTransferStatus,
    getApiKeys,
    updateApiKey,
    getApiKeyByKey,
    getWebhookUrl,
    setWebhookUrl,
    checkIdempotency,
    storeIdempotency,
    getOrCreateAccountName,
    getCustomerByBvn
};