'use client';

import { createId, nowIso } from './naming';
import { cloudFirebase, cloudFirestore, cloudRef } from './firebaseCloud';
import {
  DEFAULT_GEMINI_PREFERENCES,
  expiryIso,
  type GeneratedGeminiPdf,
  type GeminiAttachment,
  type GeminiChat,
  type GeminiMessage,
  type GeminiPreferences,
  type PdfGenerationRule,
} from './geminiTypes';

/* eslint-disable @typescript-eslint/no-explicit-any */

function toIso(value: any, fallback = nowIso()): string {
  if (typeof value === 'string') return value;
  if (value?.toDate) return value.toDate().toISOString();
  return fallback;
}

async function timestamp(value: string): Promise<any> {
  const firebase = await cloudFirebase();
  return firebase.firestore.Timestamp.fromDate(new Date(value));
}

function userPath(uid: string, suffix: string): string {
  return `users/${uid}/${suffix}`;
}

export function subscribeGeminiMessages(
  uid: string,
  date: string,
  listener: (messages: GeminiMessage[]) => void,
  onError?: (error: unknown) => void,
): () => void {
  let unsubscribe = () => {};
  let active = true;

  void cloudFirestore()
    .then((db) => {
      if (!active) return;
      unsubscribe = db
        .collection(userPath(uid, `geminiChats/${date}/messages`))
        .orderBy('createdAt', 'asc')
        .onSnapshot(
          (snapshot: any) => {
            const messages = snapshot.docs.map((doc: any) => {
              const data = doc.data();
              return {
                id: doc.id,
                role: data.role === 'model' ? 'model' : 'user',
                text: String(data.text ?? ''),
                createdAt: toIso(data.createdAt),
                expiresAt: toIso(data.expiresAt, expiryIso(date)),
                attachments: Array.isArray(data.attachments) ? data.attachments : [],
                status: data.status ?? 'complete',
              } satisfies GeminiMessage;
            });
            listener(messages);
          },
          (error: unknown) => onError?.(error),
        );
    })
    .catch((error) => onError?.(error));

  return () => {
    active = false;
    unsubscribe();
  };
}

export function subscribeGeminiChats(
  uid: string,
  listener: (chats: GeminiChat[]) => void,
  onError?: (error: unknown) => void,
): () => void {
  let unsubscribe = () => {};
  let active = true;

  void cloudFirestore()
    .then((db) => {
      if (!active) return;
      unsubscribe = db
        .collection(userPath(uid, 'geminiChats'))
        .orderBy('date', 'desc')
        .limit(7)
        .onSnapshot(
          (snapshot: any) => {
            listener(
              snapshot.docs.map((doc: any) => {
                const data = doc.data();
                return {
                  date: doc.id,
                  title: String(data.title ?? `${doc.id}のチャット`),
                  createdAt: toIso(data.createdAt),
                  updatedAt: toIso(data.updatedAt),
                  expiresAt: toIso(data.expiresAt, expiryIso(doc.id)),
                  messageCount: Number(data.messageCount ?? 0),
                } satisfies GeminiChat;
              }),
            );
          },
          (error: unknown) => onError?.(error),
        );
    })
    .catch((error) => onError?.(error));

  return () => {
    active = false;
    unsubscribe();
  };
}

export async function saveGeminiMessage(
  uid: string,
  date: string,
  input: Pick<GeminiMessage, 'role' | 'text' | 'attachments'>,
): Promise<GeminiMessage> {
  const db = await cloudFirestore();
  const firebase = await cloudFirebase();
  const messageRef = db.collection(userPath(uid, `geminiChats/${date}/messages`)).doc();
  const chatRef = db.doc(userPath(uid, `geminiChats/${date}`));
  const createdAt = nowIso();
  const expiresAt = expiryIso(date);
  const batch = db.batch();

  batch.set(messageRef, {
    role: input.role,
    text: input.text,
    attachments: input.attachments,
    status: 'complete',
    createdAt: firebase.firestore.Timestamp.fromDate(new Date(createdAt)),
    expiresAt: firebase.firestore.Timestamp.fromDate(new Date(expiresAt)),
  });
  batch.set(
    chatRef,
    {
      date,
      title: `${date}のチャット`,
      createdAt: firebase.firestore.Timestamp.fromDate(new Date(`${date}T00:00:00+09:00`)),
      updatedAt: firebase.firestore.Timestamp.fromDate(new Date(createdAt)),
      expiresAt: firebase.firestore.Timestamp.fromDate(new Date(expiresAt)),
      messageCount: firebase.firestore.FieldValue.increment(1),
    },
    { merge: true },
  );
  await batch.commit();

  return {
    id: messageRef.id,
    role: input.role,
    text: input.text,
    attachments: input.attachments,
    status: 'complete',
    createdAt,
    expiresAt,
  };
}

export async function updateGeminiChatTitle(uid: string, date: string, title: string): Promise<void> {
  const db = await cloudFirestore();
  await db.doc(userPath(uid, `geminiChats/${date}`)).set(
    {
      title: title.trim().slice(0, 80) || `${date}のチャット`,
      updatedAt: await timestamp(nowIso()),
    },
    { merge: true },
  );
}

export async function resetGeminiChat(uid: string, date: string): Promise<void> {
  const db = await cloudFirestore();
  const snapshot = await db.collection(userPath(uid, `geminiChats/${date}/messages`)).get();
  const batch = db.batch();
  const attachments: GeminiAttachment[] = [];
  snapshot.docs.forEach((doc: any) => {
    const data = doc.data();
    if (Array.isArray(data.attachments)) attachments.push(...data.attachments);
    batch.delete(doc.ref);
  });
  batch.delete(db.doc(userPath(uid, `geminiChats/${date}`)));
  await batch.commit();
  await Promise.all(
    attachments.map((entry) => cloudRef(entry.storagePath).then((ref) => ref.delete()).catch(() => undefined)),
  );
}

export async function cleanupExpiredGeminiChats(uid: string): Promise<number> {
  const db = await cloudFirestore();
  const firebase = await cloudFirebase();
  const snapshot = await db
    .collection(userPath(uid, 'geminiChats'))
    .where('expiresAt', '<=', firebase.firestore.Timestamp.now())
    .limit(20)
    .get();

  let removed = 0;
  for (const chatDoc of snapshot.docs) {
    await resetGeminiChat(uid, chatDoc.id);
    removed += 1;
  }
  return removed;
}

const ALLOWED_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export async function uploadGeminiAttachment(
  uid: string,
  date: string,
  blob: Blob,
  rawName: string,
): Promise<GeminiAttachment> {
  if (!ALLOWED_ATTACHMENT_TYPES.has(blob.type)) {
    throw new Error('PDF、JPEG、PNG、WebPだけ添付できます。');
  }
  if (blob.size <= 0 || blob.size > 15 * 1024 * 1024) {
    throw new Error('添付ファイルは1件15MB以下にしてください。');
  }

  const id = createId('gemini-attachment');
  const safeName = rawName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'attachment';
  const extension = safeName.includes('.') ? safeName.split('.').pop() : 'bin';
  const storagePath = `users/${uid}/gemini-temp/${date}/${id}.${extension}`;
  const ref = await cloudRef(storagePath);
  const task = await ref.put(blob, {
    contentType: blob.type,
    cacheControl: 'private,no-store',
    customMetadata: { originalName: safeName, expiresAt: expiryIso(date) },
  });
  const downloadUrl = await task.ref.getDownloadURL();

  return {
    id,
    name: safeName,
    mimeType: blob.type as GeminiAttachment['mimeType'],
    size: blob.size,
    storagePath,
    downloadUrl,
  };
}

export async function deleteGeminiAttachment(attachment: GeminiAttachment): Promise<void> {
  await cloudRef(attachment.storagePath)
    .then((ref) => ref.delete())
    .catch(() => undefined);
}

export async function readGeminiPreferences(uid: string): Promise<GeminiPreferences> {
  const db = await cloudFirestore();
  const snapshot = await db.doc(userPath(uid, 'geminiSettings/default')).get();
  return { ...DEFAULT_GEMINI_PREFERENCES, ...(snapshot.exists ? snapshot.data() : {}) };
}

export async function saveGeminiPreferences(
  uid: string,
  preferences: GeminiPreferences,
): Promise<void> {
  const db = await cloudFirestore();
  await db.doc(userPath(uid, 'geminiSettings/default')).set(
    { ...preferences, updatedAt: await timestamp(nowIso()) },
    { merge: true },
  );
}

export function subscribePdfGenerationRules(
  uid: string,
  listener: (rules: PdfGenerationRule[]) => void,
  onError?: (error: unknown) => void,
): () => void {
  let unsubscribe = () => {};
  let active = true;
  void cloudFirestore()
    .then((db) => {
      if (!active) return;
      unsubscribe = db
        .collection(userPath(uid, 'pdfGenerationRules'))
        .orderBy('createdAt', 'asc')
        .onSnapshot(
          (snapshot: any) => {
            listener(
              snapshot.docs.map((doc: any) => {
                const data = doc.data();
                return {
                  ...data,
                  id: doc.id,
                  createdAt: toIso(data.createdAt),
                  updatedAt: toIso(data.updatedAt),
                  lastRunAt: data.lastRunAt ? toIso(data.lastRunAt) : undefined,
                } as PdfGenerationRule;
              }),
            );
          },
          (error: unknown) => onError?.(error),
        );
    })
    .catch((error) => onError?.(error));
  return () => {
    active = false;
    unsubscribe();
  };
}

export async function savePdfGenerationRule(
  uid: string,
  rule: Omit<PdfGenerationRule, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
): Promise<string> {
  const db = await cloudFirestore();
  const firebase = await cloudFirebase();
  const ref = rule.id
    ? db.doc(userPath(uid, `pdfGenerationRules/${rule.id}`))
    : db.collection(userPath(uid, 'pdfGenerationRules')).doc();
  const current = await ref.get();
  const value = { ...rule } as Record<string, unknown>;
  delete value.id;
  await ref.set(
    {
      ...value,
      createdAt: current.exists
        ? current.data().createdAt
        : firebase.firestore.Timestamp.fromDate(new Date()),
      updatedAt: firebase.firestore.Timestamp.fromDate(new Date()),
    },
    { merge: true },
  );
  return ref.id;
}

export async function deletePdfGenerationRule(uid: string, ruleId: string): Promise<void> {
  const db = await cloudFirestore();
  await db.doc(userPath(uid, `pdfGenerationRules/${ruleId}`)).delete();
}

export async function listReadyGeneratedPdfs(uid: string): Promise<GeneratedGeminiPdf[]> {
  const db = await cloudFirestore();
  const snapshot = await db
    .collection(userPath(uid, 'geminiGeneratedPdfs'))
    .where('status', '==', 'ready')
    .limit(10)
    .get();
  return snapshot.docs.map((doc: any) => {
    const data = doc.data();
    return {
      ...data,
      id: doc.id,
      createdAt: toIso(data.createdAt),
      importedAt: data.importedAt ? toIso(data.importedAt) : undefined,
      cleanupAt: data.cleanupAt ? toIso(data.cleanupAt) : undefined,
    } as GeneratedGeminiPdf;
  });
}

export async function markGeneratedPdfImported(
  uid: string,
  id: string,
  localFileId: string,
): Promise<void> {
  const db = await cloudFirestore();
  const firebase = await cloudFirebase();
  await db.doc(userPath(uid, `geminiGeneratedPdfs/${id}`)).set(
    {
      status: 'imported',
      localFileId,
      importedAt: firebase.firestore.Timestamp.fromDate(new Date()),
      cleanupAt: firebase.firestore.Timestamp.fromDate(new Date(Date.now() + 7 * 86400000)),
    },
    { merge: true },
  );
}
