/**
 * Simple audio player for voice narration.
 * Queues audio clips and plays them sequentially.
 * Uses HTML Audio element for broad browser support.
 */

function createWavBlob(pcmData: Uint8Array, sampleRate: number, numChannels: number, bitsPerSample: number): Blob {
    const header = new ArrayBuffer(44);
    const view = new DataView(header);

    const writeString = (offset: number, string: string) => {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + pcmData.length, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
    view.setUint16(32, numChannels * (bitsPerSample / 8), true);
    view.setUint16(34, bitsPerSample, true);
    writeString(36, 'data');
    view.setUint32(40, pcmData.length, true);

    return new Blob([header, pcmData as any], { type: 'audio/wav' });
}

class VoicePlayer {
    private queue: { audio: string; mimeType: string; text?: string }[] = [];
    private playing = false;
    private _enabled = false;

    get enabled() {
        return this._enabled;
    }

    set enabled(value: boolean) {
        this._enabled = value;
        if (!value) {
            this.queue = [];
            this.playing = false;
        }
    }

    enqueue(audio: string, mimeType: string, text?: string) {
        if (!this._enabled) {
            console.log(`[VoicePlayer] Dropped audio for "${text}" (voice disabled)`);
            return;
        }
        console.log(`[VoicePlayer] Enqueued audio for "${text}" (queue size: ${this.queue.length + 1})`);
        this.queue.push({ audio, mimeType, text });
        if (!this.playing) {
            this.playNext();
        }
    }

    private async playNext() {
        if (this.queue.length === 0) {
            this.playing = false;
            return;
        }

        this.playing = true;
        const { audio, mimeType, text } = this.queue.shift()!;
        console.log(`[VoicePlayer] Playing: "${text}"`);

        try {
            // Decode base64 to ArrayBuffer
            const binaryString = atob(audio);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            // Create blob and play via Audio element
            let blob: Blob;
            if (mimeType.includes("pcm")) {
                // Gemini TTS returns 24kHz 16-bit mono PCM data
                blob = createWavBlob(bytes, 24000, 1, 16);
            } else {
                blob = new Blob([bytes], { type: mimeType });
            }

            const url = URL.createObjectURL(blob);
            const audioEl = new Audio(url);

            await new Promise<void>((resolve) => {
                audioEl.onended = () => {
                    console.log(`[VoicePlayer] Finished playing: "${text}"`);
                    URL.revokeObjectURL(url);
                    resolve();
                };
                audioEl.onerror = (e) => {
                    console.error(`[VoicePlayer] Audio element error:`, e);
                    URL.revokeObjectURL(url);
                    resolve(); // Don't block on errors
                };
                audioEl.play().catch((e) => {
                    console.error(`[VoicePlayer] Playback rejected by browser policy:`, e);
                    resolve();
                });
            });
        } catch (err) {
            console.warn("[Voice] Playback failed:", err);
        }

        // Play next in queue
        this.playNext();
    }
}

export const voicePlayer = new VoicePlayer();
