import { authErrorResponse, verifyFirebaseRequest } from '@/lib/server/firebaseAuth';
import {
  enforceGeminiRateLimit,
  geminiErrorResponse,
  openGeminiStream,
  transformGeminiSse,
} from '@/lib/server/geminiApi';
import { DEFAULT_GEMINI_PREFERENCES, type GeminiMessage, type GeminiPreferences } from '@/lib/geminiTypes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type ChatBody = {
  messages?: Pick<GeminiMessage, 'role' | 'text' | 'attachments'>[];
  preferences?: Partial<GeminiPreferences>;
};

export async function POST(request: Request) {
  try {
    const user = await verifyFirebaseRequest(request);
    enforceGeminiRateLimit(user.uid);

    const body = (await request.json()) as ChatBody;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const preferences: GeminiPreferences = {
      ...DEFAULT_GEMINI_PREFERENCES,
      ...(body.preferences ?? {}),
    };

    const upstream = await openGeminiStream({
      uid: user.uid,
      messages,
      preferences,
      signal: request.signal,
    });

    return new Response(transformGeminiSse(upstream.body as ReadableStream<Uint8Array>), {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    const auth = authErrorResponse(error);
    if (auth) return auth;
    const gemini = geminiErrorResponse(error);
    if (gemini) return gemini;

    console.error('Gemini chat failed:', error instanceof Error ? error.message : 'unknown');
    const message =
      error instanceof Error && error.message.startsWith('GEMINI_')
        ? 'Geminiから回答を取得できませんでした。時間を置いて再送信してください。'
        : '送信内容を確認できませんでした。';
    return Response.json({ error: message }, { status: 400 });
  }
}
