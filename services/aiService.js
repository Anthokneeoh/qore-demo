const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function getAIHint(errorCode, field, detail, endpoint) {
    const prompt = `You are an API integration assistant for a Nigerian fintech platform called Qore.
A developer received this error:
Error code: ${errorCode}
Field: ${field || 'none'}
Detail: ${detail}
Endpoint: ${endpoint}
Write a single helpful correction hint in under 150 characters. Be specific to the Detail.
Examples:
- If Detail says "Email already registered" → "Email already exists. Use a different email address."
- If Detail says "Phone already registered" → "Phone number already registered. Use a different number or retrieve existing customer."
- If Detail says "BVN is already registered" → "BVN must be unique. This BVN belongs to another customer."
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