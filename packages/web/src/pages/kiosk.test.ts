import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { isUnpaired } from './KioskPage';

describe('kiosk pairing', () => {
  beforeEach(() => localStorage.setItem('ritrovo.kioskToken', 'device-key'));

  it('forgets a revoked device key so the panel asks to be paired again', () => {
    expect(isUnpaired(new ApiError(401, 'UNAUTHORIZED', 'Pannello non abbinato o revocato.'))).toBe(true);
    expect(localStorage.getItem('ritrovo.kioskToken')).toBeNull();
  });

  it('keeps the key on network errors and on refused actions', () => {
    expect(isUnpaired(new ApiError(0, 'NETWORK', 'offline'))).toBe(false);
    expect(isUnpaired(new ApiError(409, 'CONFLICT', 'Sala occupata'))).toBe(false);
    expect(isUnpaired(new Error('boom'))).toBe(false);
    expect(localStorage.getItem('ritrovo.kioskToken')).toBe('device-key');
  });
});
