import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

async function testGemini() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("❌ GEMINI_API_KEY not found in .env");
        process.exit(1);
    }

    console.log("Testing Gemini API connectivity...");
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const result = await model.generateContent("Hello! Are you connected and working correctly? Reply with 'API SUCCESS'.");
        const response = await result.response;
        const text = response.text();
        
        console.log("Response from Gemini:");
        console.log(text);
        
        if (text.includes("API SUCCESS") || text.length > 0) {
            console.log("✅ Gemini API Connectivity: SUCCESS");
        } else {
            console.log("⚠️ Gemini API Connectivity: UNKNOWN (Empty response)");
        }
    } catch (error) {
        console.error("❌ Gemini API Connectivity: FAILED");
        console.error(error);
        process.exit(1);
    }
}

testGemini();
