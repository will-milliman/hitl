import { type CreateTRPCReact, createTRPCReact } from '@trpc/react-query';

import type { AppRouter } from '../../main/trpc/router';

export const trpc: CreateTRPCReact<AppRouter, unknown, null> = createTRPCReact<AppRouter>();
