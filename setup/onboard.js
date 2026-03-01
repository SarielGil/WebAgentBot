import inquirer from "inquirer";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", ".env");

async function runOnboarding() {
    console.log("=========================================");
    console.log("🚀 WebBot Builder - Initial Setup 🚀");
    console.log("=========================================\n");
    console.log("Let's configure your integration keys. These will be saved locally in a .env file.\n");

    const questions = [
        {
            type: "input",
            name: "TELEGRAM_BOT_TOKEN",
            message: "Enter your Telegram Bot Token (from @BotFather):",
            validate: (input) => (input.trim() ? true : "Token is required"),
        },
        {
            type: "input",
            name: "GITHUB_TOKEN",
            message: "Enter your GitHub Personal Access Token (needs repo creation scope):",
            validate: (input) => (input.trim() ? true : "Token is required"),
        },
        {
            type: "input",
            name: "SLACK_WEBHOOK_URL",
            message: "Enter your Slack Webhook URL for admin escalation alerts:",
            validate: (input) => (input.trim() ? true : "URL is required"),
        },
        {
            type: "input",
            name: "GEMINI_API_KEY",
            message: "Enter your Google Gemini API Key:",
            validate: (input) => (input.trim() ? true : "API Key is required"),
        },
    ];

    const answers = await inquirer.prompt(questions);

    let envContent = "";
    for (const [key, value] of Object.entries(answers)) {
        envContent += `${key}=${value}\n`;
    }

    await fs.writeFile(ENV_PATH, envContent, "utf-8");

    console.log("\n✅ Configuration saved to .env successfully!");
    console.log("You can now build and run the Docker containers.");
}

runOnboarding().catch((err) => {
    console.error("Setup failed:", err);
    process.exit(1);
});
