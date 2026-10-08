// Content fingerprint, shared by the build (versioned URLs) and the static server (ETag): they must agree.
import { createHash } from 'node:crypto';
export const fingerprint = buf => createHash('sha1').update(buf).digest('base64url').slice(0, 16);
