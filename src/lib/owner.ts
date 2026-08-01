/**
 * 「いま使っている人」の識別子。
 *
 * クラウドへログインしていれば Firebase の UID、していなければ端末ローカル
 * (LOCAL_OWNER_ID) を使う。メモと自動分類ルールは、この識別子で持ち主を分ける。
 * CloudStore がログイン状態の変化に合わせて setOwnerId を呼ぶ。
 */
import { LOCAL_OWNER_ID } from './types';

let ownerId: string = LOCAL_OWNER_ID;

export function currentOwnerId(): string {
  return ownerId;
}

/**
 * ログイン状態が変わったときに呼ぶ。
 * 別アカウントでログインした人に、前の人のデータが見えないようにするための土台。
 */
export function setOwnerId(uid: string | null | undefined): void {
  ownerId = uid || LOCAL_OWNER_ID;
}

/**
 * 現在の持ち主が読み書きしてよいデータか。
 *
 * ログイン前に作られたデータ (LOCAL_OWNER_ID) は、この端末を使っている本人のものなので
 * ログイン後も引き続き見える。別 UID のデータは、ログインしていても一切見せない。
 */
export function isOwnedBy(userId: string | undefined): boolean {
  return userId === ownerId || userId === LOCAL_OWNER_ID;
}
