'use client';

/**
 * クラウド保管とGemini機能で使う Firebase クライアント
 * (Authentication + Storage + Firestore)。
 *
 * Firebase SDKはブラウザーで必要になった時だけCDNから読み込む。
 * ここにある設定は公開用のウェブ設定だけで、管理者秘密鍵は含めない。
 */

const FIREBASE_VERSION = '10.0.0';
const APP_NAME = 'pdf-cloud-storage';

export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCg3zD2xkq_3e5MclG9YK_uVqVzWulO9Ws',
  authDomain: 'my-az900-app.firebaseapp.com',
  projectId: 'my-az900-app',
  storageBucket: 'my-az900-app.firebasestorage.app',
  messagingSenderId: '989248012630',
  appId: '1:989248012630:web:1801a2033c56887320d6f7',
};

export type CloudUser = {
  uid: string;
  email: string | null;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export type FirebaseServices = {
  auth: any;
  storage: any;
  firestore: any;
  firebase: any;
};

declare global {
  interface Window {
    firebase?: any;
  }
}

let servicesPromise: Promise<FirebaseServices> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-firebase-cloud="${src}"]`,
    );
    if (existing?.dataset.loaded === '1') {
      resolve();
      return;
    }
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener(
        'error',
        () => reject(new Error('Firebase SDKを読み込めませんでした')),
        { once: true },
      );
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.firebaseCloud = src;
    script.addEventListener(
      'load',
      () => {
        script.dataset.loaded = '1';
        resolve();
      },
      { once: true },
    );
    script.addEventListener(
      'error',
      () => reject(new Error('Firebase SDKを読み込めませんでした')),
      { once: true },
    );
    document.head.append(script);
  });
}

export async function getCloudServices(): Promise<FirebaseServices> {
  if (typeof window === 'undefined') throw new Error('ブラウザーでのみ利用できます');
  if (servicesPromise) return servicesPromise;

  servicesPromise = (async () => {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
    await loadScript(`${base}/firebase-app-compat.js`);
    await Promise.all([
      loadScript(`${base}/firebase-auth-compat.js`),
      loadScript(`${base}/firebase-storage-compat.js`),
      loadScript(`${base}/firebase-firestore-compat.js`),
    ]);

    const firebase = window.firebase;
    if (!firebase) throw new Error('Firebaseを初期化できませんでした');
    const app =
      firebase.apps?.find((candidate: any) => candidate.name === APP_NAME) ??
      firebase.initializeApp(FIREBASE_CONFIG, APP_NAME);

    const auth = app.auth();
    try {
      await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    } catch {
      // 保存制限のある環境ではFirebase既定の永続化方式を使用する。
    }

    const firestore = app.firestore();
    try {
      await firestore.enablePersistence({ synchronizeTabs: true });
    } catch {
      // 複数タブ競合や非対応ブラウザーではオンライン利用へフォールバックする。
    }

    return { auth, storage: app.storage(), firestore, firebase };
  })().catch((error) => {
    servicesPromise = null;
    throw error;
  });

  return servicesPromise;
}

function toCloudUser(user: any): CloudUser | null {
  if (!user?.uid) return null;
  return { uid: user.uid, email: user.email ?? null };
}

/** ログイン状態の変化を購読する。 */
export function subscribeCloudAuth(
  listener: (user: CloudUser | null, ready: boolean) => void,
): () => void {
  let active = true;
  let unsubscribe = () => {};

  void getCloudServices()
    .then(({ auth }) => {
      if (!active) return;
      unsubscribe = auth.onAuthStateChanged((user: any) => listener(toCloudUser(user), true));
    })
    .catch(() => {
      if (active) listener(null, false);
    });

  return () => {
    active = false;
    unsubscribe();
  };
}

export async function cloudSignIn(email: string, password: string): Promise<CloudUser> {
  const { auth } = await getCloudServices();
  const credential = await auth.signInWithEmailAndPassword(email.trim(), password);
  const user = toCloudUser(credential.user);
  if (!user) throw new Error('ログインできませんでした');
  return user;
}

export async function cloudSignUp(email: string, password: string): Promise<CloudUser> {
  const { auth } = await getCloudServices();
  const credential = await auth.createUserWithEmailAndPassword(email.trim(), password);
  const user = toCloudUser(credential.user);
  if (!user) throw new Error('登録できませんでした');
  return user;
}

/**
 * ログアウトする。端末内のPDF・フォルダー・タグ・メモには触れない。
 */
export async function cloudSignOut(): Promise<void> {
  const { auth } = await getCloudServices();
  await auth.signOut();
}

export async function currentCloudUser(): Promise<CloudUser | null> {
  const { auth } = await getCloudServices();
  return toCloudUser(auth.currentUser);
}

/** ログインが今も有効か確認する。 */
export async function requireCloudUser(): Promise<CloudUser> {
  const { auth } = await getCloudServices();
  const user = auth.currentUser;
  if (!user) throw new Error('SIGNED_OUT');
  await user.getIdToken(false);
  return toCloudUser(user) as CloudUser;
}

/** Vercel APIへ渡すFirebase IDトークンを取得する。 */
export async function cloudIdToken(forceRefresh = false): Promise<string> {
  const { auth } = await getCloudServices();
  const user = auth.currentUser;
  if (!user) throw new Error('SIGNED_OUT');
  return user.getIdToken(forceRefresh);
}

/** Storageの参照を得る。 */
export async function cloudRef(path: string): Promise<any> {
  const { storage } = await getCloudServices();
  return storage.ref(path);
}

/** Firestoreインスタンスを得る。 */
export async function cloudFirestore(): Promise<any> {
  const { firestore } = await getCloudServices();
  return firestore;
}

/** Firebase互換SDK本体を得る。TimestampやFieldValueが必要な処理で使用する。 */
export async function cloudFirebase(): Promise<any> {
  const { firebase } = await getCloudServices();
  return firebase;
}

export function cloudErrorCode(error: unknown): string {
  return String((error as { code?: string })?.code ?? (error as Error)?.message ?? '');
}

export function cloudErrorMessage(error: unknown): string {
  const code = cloudErrorCode(error);
  if (code.includes('invalid-email')) return 'メールアドレスの形式を確認してください。';
  if (code.includes('weak-password')) return 'パスワードは6文字以上にしてください。';
  if (code.includes('email-already-in-use')) return 'このメールアドレスはすでに登録されています。';
  if (
    code.includes('invalid-credential') ||
    code.includes('wrong-password') ||
    code.includes('user-not-found')
  ) {
    return 'メールアドレスまたはパスワードが正しくありません。';
  }
  if (code.includes('too-many-requests')) return '試行回数が多いため、一度時間を置いてください。';
  if (code.includes('network-request-failed')) return '通信できません。ネットワーク接続を確認してください。';
  if (
    code.includes('storage/unauthorized') ||
    code.includes('permission-denied') ||
    code.includes('firestore/permission-denied')
  ) {
    return 'Firebaseの権限がありません。セキュリティルールを確認してください。';
  }
  if (code.includes('storage/quota-exceeded') || code.includes('resource-exhausted')) {
    return 'クラウドの保存容量または利用上限を超えました。';
  }
  if (code.includes('storage/object-not-found')) {
    return 'クラウド上にファイルが見つかりませんでした。';
  }
  if (code.includes('storage/unknown') || code.includes('storage/retry-limit-exceeded')) {
    return 'クラウドとの通信に失敗しました。時間をおいてお試しください。';
  }
  const message = error instanceof Error ? error.message : '';
  return message || 'クラウド処理に失敗しました。';
}
