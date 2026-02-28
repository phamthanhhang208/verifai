import { GoogleGenAI } from "@google/genai";
import * as dotenv from "dotenv";
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });

async function main() {
  console.log("Testing TTS...");
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [
        {
          role: "user",
          parts: [{ text: "Hello, this is a test audio generation." }]
        }
      ],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Kore" }
          }
        }
      }
    });
    const candidate = response.candidates?.[0];
    console.log("Parts array:", candidate?.content?.parts?.map(p => ({
      hasInlineData: !!p.inlineData,
      mimeType: p.inlineData?.mimeType,
      dataLength: p.inlineData?.data?.length,
      text: p.text
    })));
  } catch (e: any) {
    console.error(e.message);
  }
}
main();
