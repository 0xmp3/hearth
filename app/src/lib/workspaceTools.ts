// Tool definitions for the workspace tools.
//
// Kept apart from tools.ts only for size: the executor lives there. The text
// here is the part that decides whether the model uses them well, so it says
// what the tools are for, what they are not, and how to cite what it finds.

import type { ToolDef } from './stream'

export const LIST_FILES: ToolDef = {
  name: 'list_files',
  description:
    'List the files and folders in the workspace, relative to its root. Use it once to learn ' +
    'the shape of a project before searching, or when you do not know a path. Skips build ' +
    'outputs, dependencies and binary files; two levels deep by default.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Folder to list, relative to the workspace root. Default "."' },
      depth: { type: 'integer', description: 'How many levels to descend. Default 2, maximum 4.' },
    },
    additionalProperties: false,
  },
}

export const SEARCH_FILES: ToolDef = {
  name: 'search_files',
  description:
    'Search the text of every file in the workspace and return matching lines with file and ' +
    'line number. This is the fastest way to find where something is defined, used or ' +
    'mentioned. Case-insensitive; set regex true for a pattern. Search for an identifier or a ' +
    'distinctive phrase, not a whole question.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to find. Tabs, newlines and regex syntax are matched literally unless regex is true.' },
      path: { type: 'string', description: 'Folder to search in, relative to the workspace root. Default "."' },
      regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
      limit: { type: 'integer', description: 'Maximum hits. Default 60, maximum 200.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
}

export const READ_FILE: ToolDef = {
  name: 'read_file',
  description:
    'Read a text file from the workspace, with line numbers. Read the lines around a search ' +
    'hit rather than the whole file — start and lines let you page through something large. ' +
    'Never guess at a file\u2019s contents: if you did not read it, do not describe it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root.' },
      start: { type: 'integer', description: 'First line to read, 1-based. Default 1.' },
      lines: { type: 'integer', description: 'How many lines to read. Default 200, maximum 800.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
}

export const WORKSPACE_TOOLS: ToolDef[] = [LIST_FILES, SEARCH_FILES, READ_FILE]

export const WORKSPACE_GUIDANCE = `You also have three tools for the folder the user has opened: list_files, search_files and read_file. They read only that folder.

Work like you would in an editor. To answer a question about the project, search for the identifier or phrase first, then read the lines around the best hit; do not list every file or read whole files hoping. Cite what you find as path:line so the user can check it, and say plainly when the folder does not contain the answer. Never describe a file you have not read, and never invent a path — if a search returns nothing, search again with a different term before concluding it is not there.`
