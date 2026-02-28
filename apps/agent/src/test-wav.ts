import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import * as dotenv from "dotenv";
dotenv.config();

function createWavFile(pcmData: Uint8Array, sampleRate: number, numChannels: number, bitsPerSample: number): Buffer {
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmData.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
    header.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmData.length, 40);

    // Gemini 2.5 TTS returns Big-Endian (be) PCM data.
    // WAV format strictly requires Little-Endian (le) PCM data.
    const swappedPcm = new Uint8Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i += 2) {
        swappedPcm[i] = pcmData[i + 1];
        swappedPcm[i + 1] = pcmData[i];
    }

    return Buffer.concat([header, Buffer.from(swappedPcm)]);
}


const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });

async function main() {
    console.log("Testing TTS...");
    try {
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash-preview-tts",
            contents: [
                {
                    role: "user",
                    parts: [{ text: "Hello, this is a test audio generation verifying the WAV format." }]
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
        const part = candidate?.content?.parts?.[0];

        if (part?.inlineData) {
            console.log("Got audio payload:", part.inlineData.mimeType, part.inlineData.data.length, "bytes base64");

            // decode base64
            const buf = Buffer.from(part.inlineData.data, "base64");

            // encode to wav
            const wav = createWavFile(new Uint8Array(buf), 24000, 1, 16);
            fs.writeFileSync("/tmp/test.wav", wav);
            console.log("Saved to /tmp/test.wav");
        }
    } catch (e: any) {
        console.error(e.message);
    }
}
main();
