import type { ConflictPayload } from '@ritrovo/shared';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'VALIDATION', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Accesso richiesto.') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Non hai i permessi per questa operazione.') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Elemento non trovato.') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(public readonly payload: ConflictPayload) {
    super(409, payload.code, payload.message, payload);
  }
}

export class StateError extends AppError {
  constructor(message: string) {
    super(422, 'INVALID_STATE', message);
  }
}

export class ExternalServiceError extends AppError {
  constructor(message: string, details?: unknown) {
    super(502, 'EXCHANGE_ERROR', message, details);
  }
}
