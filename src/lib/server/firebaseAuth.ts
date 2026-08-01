export type VerifiedFirebaseUser = {
  uid: string;
  email?: string;
};

type LookupResponse = {
  users?: Array<{ localId?: string; email?: string }>;
  error?: { message?: string };
};

const PUBLIC_FIREBASE_WEB_API_KEY = 'AIzaSyCg3zD2xkq_3e5MclG9YK_uVqVzWulO9Ws';

export async function verifyFirebaseRequest(request: Request): Promise<VerifiedFirebaseUser> {
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) throw new Error('UNAUTHENTICATED');

  const apiKey = process.env.FIREBASE_WEB_API_KEY || PUBLIC_FIREBASE_WEB_API_KEY;
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
      cache: 'no-store',
    },
  );
  const data = (await response.json()) as LookupResponse;
  const user = data.users?.[0];
  if (!response.ok || !user?.localId) throw new Error('UNAUTHENTICATED');
  return { uid: user.localId, email: user.email };
}

export function authErrorResponse(error: unknown): Response | null {
  if (error instanceof Error && error.message === 'UNAUTHENTICATED') {
    return Response.json(
      { error: 'ログインの有効期限が切れています。再ログインしてください。' },
      { status: 401 },
    );
  }
  return null;
}
