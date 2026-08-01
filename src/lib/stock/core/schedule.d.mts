export type Frequency = 'daily' | 'weekdays' | 'weekly' | 'manual';

export type ScheduleInput = {
  enabled?: boolean;
  frequency?: Frequency;
  weekdays?: number[];
  time?: string;
  timeZone?: string;
  lastRunDate?: string;
  lastRunStatus?: string;
};

export type ZonedParts = { date: string; time: string; minutes: number; weekday: number };

export const DEFAULT_TIME_ZONE: string;
export const FREQUENCIES: Frequency[];
export const FREQUENCY_LABELS: Record<Frequency, string>;
export const WEEKDAY_LABELS: string[];
export const TIME_ZONES: string[];

export function zonedParts(date?: Date, timeZone?: string): ZonedParts;
export function compactDate(dateKey: string): string;
export function parseTime(value: unknown): number | null;
export function formatTime(minutes: number): string;
export function addDays(dateKey: string, days: number): string;
export function weekdayOf(dateKey: string): number;
export function isScheduledDay(subscription: ScheduleInput, dateKey: string): boolean;
export function isDue(subscription: ScheduleInput, now: ZonedParts): boolean;
export function nextRunAt(subscription: ScheduleInput, from?: Date): string | null;
export function zonedIso(dateKey: string, minutes: number, timeZone?: string): string;
export function reportPeriod(
  subscription: ScheduleInput,
  runDate: string,
): { from: string; to: string };
