import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";

export const runtime = "nodejs";

type SpeechLanguage = "auto" | "english" | "spanish" | "french" | "portuguese" | "german" | "swahili" | "twi" | "kikuyu";

type DeepgramResponse = {
  err_msg?: string;
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{
        transcript?: string;
      }>;
    }>;
  };
};

function normalizeSpeechLanguage(value: string | null): SpeechLanguage {
  const normalized = (value ?? "auto").toLowerCase();
  const allowed: SpeechLanguage[] = ["auto", "english", "spanish", "french", "portuguese", "german", "swahili", "twi", "kikuyu"];
  return (allowed as string[]).includes(normalized) ? normalized as SpeechLanguage : "auto";
}

function buildAttempts(speechLanguage: SpeechLanguage): Array<{ language?: string; detectLanguage: boolean }> {
  const codeMap: Record<Exclude<SpeechLanguage, "auto">, string[]> = {
    english: ["en"],
    spanish: ["es"],
    french: ["fr"],
    portuguese: ["pt"],
    german: ["de"],
    swahili: ["sw"],
    twi: ["ak", "twi"],
    kikuyu: ["ki", "kikuyu"],
  };

  if (speechLanguage === "auto") {
    return [
      { language: "multi", detectLanguage: true },
      { detectLanguage: true },
    ];
  }

  const manual = codeMap[speechLanguage].map((language) => ({ language, detectLanguage: false }));
  return [
    ...manual,
    { language: "multi", detectLanguage: true },
    { detectLanguage: true },
  ];
}

export async function POST(request: NextRequest) {
  if (!env.DEEPGRAM_API_KEY) {
    return NextResponse.json({ error: "DEEPGRAM_API_KEY is not configured" }, { status: 503 });
  }

  const formData = await request.formData();
  const audio = formData.get("audio");
  const speechLanguage = normalizeSpeechLanguage(formData.get("speechLanguage")?.toString() ?? null);

  if (!(audio instanceof File)) {
    return NextResponse.json({ error: "Missing audio chunk" }, { status: 400 });
  }

  const arrayBuffer = await audio.arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    return NextResponse.json({ transcript: "" });
  }

  let lastError = "Transcription request failed";

  for (const attempt of buildAttempts(speechLanguage)) {
    const params = new URLSearchParams({
      model: "nova-2",
      punctuate: "true",
      smart_format: "true",
      paragraphs: "false",
    });

    if (attempt.language) params.set("language", attempt.language);
    if (attempt.detectLanguage) params.set("detect_language", "true");

    try {
      const response = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
        method: "POST",
        headers: {
          Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
          "Content-Type": audio.type || "audio/webm",
        },
        body: arrayBuffer,
      });

      const data = await response.json() as DeepgramResponse;
      if (!response.ok) {
        lastError = data.err_msg ?? `Deepgram ${response.status}`;
        continue;
      }

      const channel = data.results?.channels?.[0];
      const transcript = channel?.alternatives?.[0]?.transcript?.trim() ?? "";
      if (!transcript) continue;

      return NextResponse.json({
        transcript,
        detectedLanguage: channel?.detected_language ?? null,
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Transcription request failed";
    }
  }

  return NextResponse.json({ error: lastError }, { status: 502 });
}
