import vscode, { TreeDataProvider, Event, ProviderResult, Uri } from 'vscode';
import os from 'os';
import fs, { Stats } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { TemplatesManager, Template } from './TemplatesManager';
import { writeFile, exists, isDir, compile, readDir } from './utils';

async function openFile(filename: string) {
  const uri = vscode.Uri.file(filename);
  const document = await vscode.workspace.openTextDocument(uri);
  if (document) {
    await vscode.window.showTextDocument(document);
  }
}

const PROMPT_YES = 'Yes';
const PROMPT_NO = 'No';

async function confirm(question: string, modal = true) {
  const result = await vscode.window.showWarningMessage(question, { modal }, PROMPT_NO, PROMPT_YES);
  return result === PROMPT_YES;
}

async function promptValue(prompt: string) {
  return vscode.window.showInputBox({
    placeHolder: 'Value',
    prompt,
  });
}

async function selectValue(placeHolder: string, items: string[]) {
  return vscode.window.showQuickPick(items, {
    placeHolder,
  });
}

export interface Interactive {
  type: string;
  message: string;
  items?: string[];
}

export interface TemplatesTreeProvider<T> extends TreeDataProvider<T> {
  showDialog(uri: Uri): Promise<void>;
  createIndex(template: Template): Promise<string | void>;
  createFile(template: Template): Promise<string | void>;
  create(): Promise<void>;
  clone(item: Template): Promise<void>;
  edit(item: Template): Promise<void>;
  rename(item: Template): Promise<void>;
  delete(item: Template): Promise<void>;
  refresh(): Promise<void>;
}

export enum DocumentType {
  Markdown,
  Attachment,
  Directory,
  Unknown
}
export interface Document {
  name: string;
  path: string;
  type: DocumentType;
  children?: Document[];
}

// TODO: Relative nav 
export function buildContentsTree(path: string, depth = 0): Document[] {
  const documents: Document[] = [];

  fs.readdirSync(path).filter(file => extname(file) !== '.html' && file !== 'index.md')
    .map(file => {
      let type = DocumentType.Unknown;
      if (fs.lstatSync(join(path, file)).isDirectory()) {
        let newDoc: Document = {
          name: file.toString(),
          path: encodeURI(join(path, file)),
          type: DocumentType.Directory,
          children: buildContentsTree(join(path, file))
        }
        documents.push(newDoc);
      } else {
        documents.push({
          name: file.toString(),
          path: encodeURI(join(path, file)),
          type: (extname(file) !== '.md' ? DocumentType.Attachment : DocumentType.Markdown)
        });
      }
    });
  return documents;
}

export function transformContentsTreeToContents(docs: Document[], depth = 0): string {
  let output = '';
  docs.forEach(doc => {
    if (doc.type === DocumentType.Directory) {
      output += `${addTabs(depth - 1)}${transformContentsNode(doc)}\n\n`;
      output += transformContentsTreeToContents(doc.children, ++depth);
    } else {
      output += `${addTabs(depth - 1)}- ${transformContentsNode(doc)}\n`;
    }
  })
  return output;
}

export function addTabs(count: number): string {
  let output = '';
  for (let index = 0; index < count; index++) {
    output += '\t';
  }
  return output;
}

/**
 * Turns a node into a markdown link
 * @param doc
 */
export function transformContentsNode(doc: Document): string {
  switch (doc.type) {
    case DocumentType.Attachment:
      return `[${doc.name} (Attachment)](${doc.path})`
    case DocumentType.Markdown:
      return `[${doc.name}](${doc.path})`
    case DocumentType.Directory:
      return `**[${doc.name}](${doc.path}/index.md)**`
    case DocumentType.Unknown:
    default:
      return '';
  }
}

export default async function createTemplatesTreeProvider(templatesManager: TemplatesManager<Template>): Promise<TemplatesTreeProvider<Template>> {
  return {
    get onDidChangeTreeData(): Event<Template> {
      return templatesManager.onDidChange.event;
    },
    getTreeItem: element => element,
    getChildren: (element: Template): ProviderResult<Template[]> => {
      if (!element) {
        return templatesManager.templates.map<Template>(({ name }) => ({
          label: name,
          resourceUri: vscode.Uri.file(templatesManager.getFilename(name)),
        }));
      }
    },
    showDialog: async (uri) => {
      const items = [
        {
          label: 'Create...',
          description: 'Create new template',
          command: 'templates.create',
        },
        {
          label: 'index',
          description: 'Create new index',
          path: uri ? uri.fsPath : templatesManager.workspacePath,
          command: 'templates.createIndex',
        },
        ...templatesManager.templates.map(({ name }) => ({
          label: name,
          path: uri ? uri.fsPath : templatesManager.workspacePath,
          command: 'templates.createFile',
        })),
      ];
      const selection = await vscode.window.showQuickPick(items, {
        placeHolder: 'Pick a template',
      });
      if (selection) {
        await vscode.commands.executeCommand(selection.command, selection);
      }
    },
    createFile: async ({ label, path }) => {
      const extension = extname(label);

      // Augment Label      // TODO: Add prefix as config option
      let name = await vscode.window.showInputBox({
        placeHolder: 'Filename',
        prompt: `Enter a filename for template ${label}`,
        value: basename(label, extension),
      });

      name = `${(new Date).toISOString().replace(/T.+/, '').replace(/-/g, '')} - ${name}`;

      if (name) {
        const template = await templatesManager.get(label);
        const dir = (await isDir(path)) ? path : dirname(path);
        const dirName = basename(dir);
        const filename = join(dir, `${name}${extension}`);

        const isExists = await exists(filename);
        if (!isExists || (await confirm(`Replace existing file "${filename}"?`))) {
          let date = new Date();
          const params = Object.assign(
            {
              DIR: dir,
              DIRNAME: dirName,
              FILE: `${name}${extension}`,
              FILE_PATH: filename,
              USER: os.userInfo().username,
              NAME: name,
              ID: `${date.toISOString().replace(/T.+/, '').replace(/-/g, '').replace(/ /g, '')}${date.toTimeString().replace(/GMT.+/, '').replace(/:/g, '').trim()}`,
              DATE: `${date.toISOString().replace(/T.+/, '')} ${date.toTimeString().replace(/GMT.+/, '').trim()}`
            },
            templatesManager.config.customVars,
          );
          const interactives: { [name: string]: Interactive } = {};
          const compiled = compile(template, {
            confirm(name: string, message: string) {
              interactives[name] = {
                type: 'confirm',
                message,
              };
              return '';
            },
            prompt(name: string, message: string) {
              interactives[name] = {
                type: 'prompt',
                message,
              };
              return '';
            },
            select(name: string, message: string, items: string[]) {
              interactives[name] = {
                type: 'select',
                message,
                items,
              };
              return '';
            },
          });
          const variables = Object.keys(interactives);
          const iterator = variables[Symbol.iterator]();
          let item = iterator.next();
          while (!item.done) {
            const key = item.value.toUpperCase();
            const interactive = interactives[key];
            switch (interactive.type) {
              case 'confirm': {
                const value = await confirm(interactives[key].message);
                params[key] = value;
              }
                break;
              case 'prompt': {
                const value = await promptValue(interactives[key].message);
                params[key] = value;
              }
                break;
              case 'select': {
                const value = await selectValue(interactives[key].message, interactives[key].items);
                params[key] = value;
              }
                break;
            }
            if (!params[key]) {
              return vscode.window.showErrorMessage(`${name} creation interrupted`);
            }
            item = iterator.next();
          }

          await writeFile(filename, compiled(params));
          return openFile(filename);
        }
      }
    },
    createIndex: async ({ label, path }) => {
      const name = "index.md";
      const dir = (await isDir(path)) ? path : dirname(path);
      const dirName = basename(dir);
      const filename = join(dir, name);

      // Scan all files in the directory
      const documents = await buildContentsTree(path);
      const contents = transformContentsTreeToContents(documents);
      const isExists = await exists(filename);
      if (!isExists || (await confirm(`Replace existing file "${filename}"?`))) {
        await writeFile(filename, `---
title: ${dirName} - Index
keywords: [index]
---

# Contents

${contents}`);
        return openFile(filename);
      }
    },
    create: async () => {
      const input = await vscode.window.showInputBox({
        placeHolder: 'Filename',
        prompt: 'Enter a template name',
      });
      if (input) {
        const isExists = await templatesManager.has(input);
        if (!isExists || (await confirm(`Replace existing template "${input}"?`))) {
          await templatesManager.set(input, '');
          const filename = templatesManager.getFilename(input);
          await openFile(filename);
        }
      }
    },
    clone: async item => {
      const input = await vscode.window.showInputBox({
        placeHolder: 'New Filename',
        prompt: `Clone template ${item.label}`,
        value: ` clone ${item.label}`,
      });
      if (input && input !== item.label) {
        const isExists = await templatesManager.has(input);
        if (!isExists || (await confirm(`Replace existing template "${item.label}"?`))) {
          await templatesManager.clone(item.label, input);
        }
      }
    },
    edit: async item => {
      if (item) {
        const filename = templatesManager.getFilename(item.label);
        await openFile(filename);
      }
    },
    rename: async item => {
      const input = await vscode.window.showInputBox({
        placeHolder: 'New Filename',
        prompt: `Rename template ${item.label}`,
        value: item.label,
      });
      if (input && input !== item.label) {
        const isExists = await templatesManager.has(input);
        if (!isExists || (await confirm(`Replace existing template "${item.label}"?`))) {
          await templatesManager.rename(item.label, input);
        }
      }
    },
    delete: async item => {
      if (item) {
        if (await confirm(`Delete template "${item.label}"?`)) {
          await templatesManager.remove(item.label);
        }
      }
    },
    refresh: templatesManager.update,
  };
};
