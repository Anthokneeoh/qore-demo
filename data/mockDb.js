const supabase = require('./supabaseClient');
const { v4: uuidv4 } = require('uuid');

// ---------- Customers ----------
async function getCustomers(filters = {}) {
    let query = supabase.from('customers').select('*');
    if (filters.email) query = query.eq('email', filters.email);
    if (filters.phone) query = query.eq('phone_number', filters.phone);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

async function createCustomer(customerData) {
    const { data, error } = await supabase.from('customers').insert([customerData]).select();
    if (error) throw error;
    return data[0];
}

async function getCustomerById(id) {
    const { data, error } = await supabase.from('customers').select('*').eq('id', id).single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
}

// ---------- Accounts ----------
async function getAccounts(filters = {}) {
    let query = supabase.from('accounts').select('*');
    if (filters.customer_id) query = query.eq('customer_id', filters.customer_id);
    if (filters.product_code) query = query.eq('product_code', filters.product_code);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

async function createAccount(accountData) {
    const { data, error } = await supabase.from('accounts').insert([accountData]).select();
    if (error) throw error;
    return data[0];
}

async function getAccountById(id) {
    const { data, error } = await supabase.from('accounts').select('*').eq('id', id).single();
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
    return data[0];
}

// ---------- Transfers ----------
async function getTransfers(filters = {}) {
    let query = supabase.from('transfers').select('*');
    if (filters.source_account_id) query = query.eq('source_account_id', filters.source_account_id);
    if (filters.status) query = query.eq('status', filters.status);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

async function getTransferById(id) {
    const { data, error } = await supabase.from('transfers').select('*').eq('id', id).single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
}

async function createTransfer(transferData) {
    const { data, error } = await supabase.from('transfers').insert([transferData]).select();
    if (error) throw error;
    return data[0];
}

async function updateTransferStatus(id, status, additionalFields = {}) {
    const { data, error } = await supabase
        .from('transfers')
        .update({ status, ...additionalFields, completed_at: new Date().toISOString() })
        .eq('id', id)
        .select();
    if (error) throw error;
    return data[0];
}

// ---------- API Keys ----------
async function getApiKeys() {
    const { data, error } = await supabase.from('api_keys').select('*');
    if (error) throw error;
    return data || [];
}

async function updateApiKey(oldKey, newKey, type) {
    // Delete old key
    await supabase.from('api_keys').delete().eq('key', oldKey);
    // Insert new key
    const { data, error } = await supabase.from('api_keys').insert([{
        key: newKey,
        type,
        label: type === 'test' ? 'Test key' : 'Live key (inactive in sandbox)',
        institution: 'Demo Bank',
        created_at: new Date().toISOString()
    }]).select();
    if (error) throw error;
    return data[0];
}

// ---------- Webhook URL ----------
async function getWebhookUrl() {
    const { data, error } = await supabase.from('webhook_urls').select('url').limit(1).single();
    if (error && error.code !== 'PGRST116') return null;
    return data?.url || null;
}

async function setWebhookUrl(url) {
    // Delete existing
    await supabase.from('webhook_urls').delete().neq('id', 0);
    const { data, error } = await supabase.from('webhook_urls').insert([{ url, created_at: new Date().toISOString() }]).select();
    if (error) throw error;
    return data[0];
}

// ---------- Idempotency cache (in-memory) ----------
const idempotencyCache = new Map();
function checkIdempotency(key) {
    const cached = idempotencyCache.get(key);
    if (!cached) return null;
    if (Date.now() > cached.expiresAt) {
        idempotencyCache.delete(key);
        return null;
    }
    return cached.response;
}
function storeIdempotency(key, response) {
    idempotencyCache.set(key, {
        response,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000
    });
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
    getWebhookUrl,
    setWebhookUrl,
    checkIdempotency,
    storeIdempotency
};