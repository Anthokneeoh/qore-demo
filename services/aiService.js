const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function getAIHint(errorCode, field, endpoint) {
    // Only call AI for 4xx (developer errors). 5xx are infra faults — no hint useful.
    const prompt = `You are an API integration assistant for a Nigerian fintech platform called Qore.
A developer received this error while calling the API.
Error code: ${errorCode}
Field: ${field || 'none'}
Endpoint: ${endpoint}
Write a single helpful correction hint in under 150 characters. Be specific.
Nigerian context: phone numbers use E.164 (+234...), amounts are in kobo (500000 = NGN 5000), BVN is 11 digits.
Reply with ONLY the hint text. No preamble.`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: prompt,
        });
        const hint = response.text?.trim();
        return hint || 'service unavailable';
    } catch (err) {
        console.error('[AI] Hint failed:', err.message);
        return 'service unavailable';
    }
}

module.exports = { getAIHint };