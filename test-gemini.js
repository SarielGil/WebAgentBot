import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const MODEL = "gemini-3-flash-preview";

async function testGemini() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("❌ GEMINI_API_KEY not found in .env");
        process.exit(1);
    }

    console.log(`Testing Gemini API connectivity with model: ${MODEL} ...`);
    try {
        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
            model: MODEL,
            contents: "Hello! Are you connected and working correctly? Reply with 'API SUCCESS'.",
        });
        const text = response.text;

        console.log("Response from Gemini:");
        console.log(text);

        if (text && (text.includes("API SUCCESS") || text.length > 0)) {
            console.log(`✅ Gemini API Connectivity (${MODEL}): SUCCESS`);
        } else {
            console.log(`⚠️ Gemini API Connectivity (${MODEL}): UNKNOWN (Empty response)`);
        }
    } catch (error) {
        console.error(`❌ Gemini API Connectivity (${MODEL}): FAILED`);
        console.error(error);
        process.exit(1);
    }
}

testGemini();
