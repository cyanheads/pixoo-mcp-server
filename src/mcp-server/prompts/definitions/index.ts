/**
 * @fileoverview Barrel file for all prompt definitions.
 * This file re-exports all prompt definitions for easy import and registration.
 * @module src/mcp-server/prompts/definitions
 */

import type { PromptDefinition } from '@/mcp-server/prompts/utils/promptDefinition.js';
import type { ZodObject, ZodRawShape } from 'zod';

/**
 * An array containing all prompt definitions for easy iteration.
 */
export const allPromptDefinitions: PromptDefinition<
  ZodObject<ZodRawShape> | undefined
>[] = [];
