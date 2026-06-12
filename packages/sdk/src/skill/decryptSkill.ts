import { FheTypes } from '@cofhe/sdk';
import type { SkillHandles, DecryptedSkill, LicenseHandles, DecryptedLicense } from './skillTypes';
import { getCofheClient } from '../client/cofheClient';

export async function decryptSkillHandles(
  handles: SkillHandles,
  permit: unknown,
): Promise<DecryptedSkill> {
  const client = getCofheClient();
  const p = permit as any;

  const results = await Promise.all([
    client.decryptHandle(handles.skillId,     FheTypes.Uint32).setPermit(p).execute(),
    client.decryptHandle(handles.basePrice,   FheTypes.Uint64).setPermit(p).execute(),
    client.decryptHandle(handles.maxSupply,   FheTypes.Uint32).setPermit(p).execute(),
    client.decryptHandle(handles.activeUsers, FheTypes.Uint32).setPermit(p).execute(),
    client.decryptHandle(handles.isActive,    FheTypes.Bool).setPermit(p).execute(),
  ]);

  return {
    skillId:     Number(results[0] as bigint),
    basePrice:   BigInt(results[1] as bigint),
    maxSupply:   Number(results[2] as bigint),
    activeUsers: Number(results[3] as bigint),
    isActive:    Boolean(results[4]),
  };
}

export async function decryptLicenseHandles(
  handles: LicenseHandles,
  permit: unknown,
): Promise<DecryptedLicense> {
  const client = getCofheClient();
  const p = permit as any;

  const results = await Promise.all([
    client.decryptHandle(handles.purchasePrice, FheTypes.Uint64).setPermit(p).execute(),
    client.decryptHandle(handles.isValid,       FheTypes.Bool).setPermit(p).execute(),
  ]);

  return {
    purchasePrice: BigInt(results[0] as bigint),
    isValid:       Boolean(results[1]),
    purchasedAt:   handles.purchasedAt,
    expiresAt:     handles.expiresAt,
  };
}
