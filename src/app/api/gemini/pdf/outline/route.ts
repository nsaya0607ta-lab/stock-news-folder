import { authErrorResponse, verifyFirebaseRequest } from '@/lib/server/firebaseAuth';
import {
  enforceGeminiRateLimit,
  generatePdfOutline,
  geminiErrorResponse,
} from '@/lib/server/geminiApi';
import {
  DEFAULT_GEMINI_PREFERENCES,
  type PdfOutlineRequest,
} from '@/lib/geminiTypes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const user = await verifyFirebaseRequest(request);
    enforceGeminiRateLimit(user.uid, 5, 60_000);

    const body = (await request.json()) as Partial<PdfOutlineRequest>;
    if (
      !body.chatDate ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.chatDate) ||
      !body.title ||
      body.title.length > 160 ||
      !Array.isArray(body.messages) ||
      body.messages.length === 0 ||
      body.messages.length > 200
    ) {
      return Response.json({ error: 'PDF作成条件が正しくありません。' }, { status: 400 });
    }

    const result = await generatePdfOutline({
      chatDate: body.chatDate,
      title: body.title,
      documentType: String(body.documentType || '学習・業務まとめ').slice(0, 80),
      additionalInstructions: String(body.additionalInstructions || '').slice(0, 4000),
      messages: body.messages.map((message) => ({
        role: message.role === 'model' ? 'model' : 'user',
        text: String(message.text || '').slice(0, 20_000),
      })),
      preferences: {
        ...DEFAULT_GEMINI_PREFERENCES,
        ...(body.preferences ?? {}),
      },
    });

    return Response.json(result, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    const auth = authErrorResponse(error);
    if (auth) return auth;
    const gemini = geminiErrorResponse(error);
    if (gemini) return gemini;

    console.error('Gemini PDF outline failed:', error instanceof Error ? error.message : 'unknown');
    return Response.json(
      { error: 'PDF用の資料構成を生成できませんでした。時間を置いて再実行してください。' },
      { status: 500 },
    );
  }
}
