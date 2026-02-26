/**
 * Vendored ParkingZone Zod schema from packages/shared/src/types/zone.ts.
 * Keep in sync manually when the source schema changes.
 */
import { z } from 'zod';

export const EnforcementType = z.enum([
  'government',
  'private',
  'council',
  'hospital',
  'university',
  'airport',
  'shopping_centre',
  'residential',
  'other',
]);

export const EnforcementMethod = z.enum([
  'camera_anpr',
  'physical_warden',
  'ticket_machine',
  'pay_and_display',
  'barrier',
  'clamp',
  'tow',
  'mixed',
  'unknown',
]);

export const OperatingHours = z.object({
  dayOfWeek: z.number().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  enforced: z.boolean(),
});

export const LatLng = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const ParkingZone = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  center: LatLng,
  radius: z.number().positive(),
  polygon: z.array(LatLng).optional(),
  enforcementType: EnforcementType,
  enforcementMethod: EnforcementMethod,
  enforcementCompany: z.string().optional(),
  legislationCode: z.string().optional(),
  freeMinutes: z.number().min(0).default(0),
  maxStayMinutes: z.number().min(0).optional(),
  chargePerHour: z.number().min(0).optional(),
  currency: z.string().length(3).default('GBP'),
  operatingHours: z.array(OperatingHours).optional(),
  noReturnMinutes: z.number().min(0).optional(),
  reparkingTips: z.string().optional(),
  country: z.string().min(2).max(2),
  region: z.string().min(1),
  city: z.string().optional(),
  verified: z.boolean().default(false),
  version: z.number().int().positive().default(1),
});

/** Schema for zone submissions (no id, verified, version required). */
export const ParkingZoneSubmission = ParkingZone.omit({
  id: true,
  verified: true,
  version: true,
});

/** Schema for zone update payloads (zoneId + partial changes). */
export const ZoneUpdatePayload = z.object({
  zoneId: z.string().min(1),
  changes: ParkingZone.omit({ id: true, verified: true, version: true }).partial(),
});

/** Schema for zone deletion payloads. */
export const ZoneDeletionPayload = z.object({
  zoneId: z.string().min(1),
  reason: z.string().optional(),
});

export const CdnZoneIndex = z.object({
  country: z.string().min(2).max(2),
  region: z.string().min(1),
  lastUpdated: z.string().datetime(),
  zoneCount: z.number().int().min(0),
  zones: z.record(z.string(), z.array(ParkingZone)),
});
