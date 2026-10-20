import { ulid } from 'ulid';

export const newUserId = (): string => `usr_${ulid()}`;
export const newAgentId = (): string => `ag_${ulid()}`;
export const newEnrollTokenId = (): string => `ent_${ulid()}`;
export const newAuditId = (): string => `aud_${ulid()}`;
export const newServiceId = (): string => `svc_${ulid()}`;
export const newServiceResultId = (): string => `res_${ulid()}`;
export const newServiceIncidentId = (): string => `inc_${ulid()}`;
export const newAiUsageId = (): string => `aiu_${ulid()}`;
