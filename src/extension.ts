// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	  // Status bar button
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.text = "$(file-code) Archive Copilot Chat";
	statusBarItem.command = 'github-copilot-chat-archiver.exportWorkspaceHistory';
	statusBarItem.tooltip = "Archive GitHub Copilot chat history";
	statusBarItem.show();
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "github-copilot-chat-archiver" is now active!');

	const exportCommand = vscode.commands.registerCommand('github-copilot-chat-archiver.exportWorkspaceHistory', async () => {
	    try {
	      // Get output directory
	      const folders = vscode.workspace.workspaceFolders || [];
	      const defaultOut = folders.length ? path.join(folders[0].uri.fsPath, 'copilot_exports') : path.join(os.homedir(), 'copilot_exports');

	      const outUri = await vscode.window.showOpenDialog({
	        canSelectFolders: true,
	        canSelectFiles: false,
	        openLabel: 'Select output folder'
	      });

	      const outDir = outUri ? outUri[0].fsPath : defaultOut;
	      await mkdir(outDir, { recursive: true } as any);

	      // Collect entries
	      interface CopilotEntry {
	        key: string;
	        content: any;
	        timestamp?: string;
	        workspace?: string;
	        type?: string;
	      }

	      const allEntries: CopilotEntry[] = [];
	      const diagnostics: string[] = [];

	      function cleanText(text: string): string {
	        if (!text) return '';
	        return text
	          .replace(/```[\w]*\n?/g, '')
	          .replace(/`([^`]+)`/g, '$1')
	          .replace(/\*\*([^*]+)\*\*/g, '$1')
	          .replace(/\*([^*]+)\*/g, '$1')
	          .replace(/\n{3,}/g, '\n\n')
	          .replace(/^\s+|\s+$/g, '')
	          .replace(/\s+/g, ' ');
	      }

	      function getVSCodeStoragePath(): string {
	        const platform = os.platform();
	        const homedir = os.homedir();
	        switch (platform) {
	          case 'win32':
	            return path.join(homedir, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage');
	          case 'darwin':
	            return path.join(homedir, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage');
	          default:
	            return path.join(homedir, '.config', 'Code', 'User', 'workspaceStorage');
	        }
	      }

	      async function getCurrentWorkspaceHash(): Promise<{ hash: string | null; diagnostics: string[] }> {
	        const diagnostics: string[] = [];
	        const folders = vscode.workspace.workspaceFolders;
	        if (!folders || folders.length === 0) {
	          diagnostics.push('No workspace folder is currently open');
	          return { hash: null, diagnostics };
	        }
	        const workspacePath = folders[0].uri.fsPath;
	        diagnostics.push(`Current workspace: ${workspacePath}`);

	        const workspaceStoragePath = getVSCodeStoragePath();
	        diagnostics.push(`Checking VS Code storage: ${workspaceStoragePath}`);

	        if (!fs.existsSync(workspaceStoragePath)) {
	          diagnostics.push('VS Code workspace storage directory not found');
	          return { hash: null, diagnostics };
	        }

	        const workspaceDirs = fs.readdirSync(workspaceStoragePath);
	        diagnostics.push(`Found ${workspaceDirs.length} workspace directories`);

	        let candidatesWithChat = 0;
	        for (const workspaceDir of workspaceDirs) {
	          const chatSessionsPath = path.join(workspaceStoragePath, workspaceDir, 'chatSessions');
	          if (fs.existsSync(chatSessionsPath)) {
	            candidatesWithChat++;
	            const sessionFiles = fs.readdirSync(chatSessionsPath).filter(f => f.endsWith('.json'));
	            if (sessionFiles.length > 0) {
	              let mostRecentTime = 0;
								for (const file of sessionFiles) {
									const stat = fs.statSync(path.join(chatSessionsPath, file));
									if (stat.mtime.getTime() > mostRecentTime) {
										mostRecentTime = stat.mtime.getTime();
									}
								}
	              const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
	              if (mostRecentTime > thirtyDaysAgo) {
	                diagnostics.push(`Found matching workspace with ${sessionFiles.length} chat sessions`);
	                return { hash: workspaceDir, diagnostics };
	              }
	            }
	          }
	        }
	        diagnostics.push(`Found ${candidatesWithChat} directories with chat sessions, but none recent`);
	        return { hash: null, diagnostics };
	      }

	      async function scanChatSessionFiles(allEntries: CopilotEntry[], diagnostics: string[]) {
	        const workspaceResult = await getCurrentWorkspaceHash();
	        if (!workspaceResult.hash) {
	          diagnostics.push(...workspaceResult.diagnostics);
	          return;
	        }
	        const currentWorkspaceHash = workspaceResult.hash;
	        diagnostics.push(...workspaceResult.diagnostics);
	        const workspaceStoragePath = getVSCodeStoragePath();
	        const chatSessionsPath = path.join(workspaceStoragePath, currentWorkspaceHash, 'chatSessions');
	        diagnostics.push(`Looking for chat sessions in: ${chatSessionsPath}`);
	
	        if (fs.existsSync(chatSessionsPath)) {
	          const sessionFiles = fs.readdirSync(chatSessionsPath).filter(f => f.endsWith('.json'));
	          diagnostics.push(`Found ${sessionFiles.length} JSON session files`);
	
	          for (const sessionFile of sessionFiles) {
	            try {
	              const filePath = path.join(chatSessionsPath, sessionFile);
	              const content = await readFile(filePath, 'utf8');
	              const chatSession = JSON.parse(content as string);
	
	              if (chatSession.requests && chatSession.requests.length > 0) {
	                for (let i = 0; i < chatSession.requests.length; i++) {
	                  const request = chatSession.requests[i];
	                  if (request.message && request.message.text) {
	                    const userMessage = cleanText(request.message.text);
	
	                    let copilotResponse = 'No response';
	                    if (request.response && Array.isArray(request.response)) {
	                      const responseParts: string[] = [];
												for (const responsePart of request.response) {
													if (responsePart && responsePart.value && typeof responsePart.value === 'string') {
														responseParts.push(cleanText(responsePart.value));
													}
												}
												if (responseParts.length > 0) {
													copilotResponse = responseParts.join(' ').trim();
												}
	                    }

	                    if (userMessage.length > 10 && copilotResponse.length > 10) {
	                      allEntries.push({
	                        key: `conversation-${i + 1}`,
	                        content: {
	                          session: chatSession.sessionId ? String(chatSession.sessionId).substring(0, 8) : 'unknown',
	                          date: chatSession.creationDate ? new Date(chatSession.creationDate).toLocaleDateString() : new Date().toLocaleDateString(),
	                          human: userMessage,
	                          copilot: copilotResponse
	                        },
	                        workspace: currentWorkspaceHash,
	                        type: 'conversation'
	                      });
	                    }
	                  }
	                }
	              }
	            } catch (error) {
	              diagnostics.push(`Error reading session file ${sessionFile}: ${String(error)}`);
	            }
	          }
	          diagnostics.push(`Processed files and found ${allEntries.length} valid conversations`);
	        } else {
	          diagnostics.push('Chat sessions directory does not exist');
	        }
	      }

	      await scanChatSessionFiles(allEntries, diagnostics);

	      if (allEntries.length > 0) {
	        const outputFile = path.join(outDir, `copilot_export_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
	        await writeFile(outputFile, JSON.stringify(allEntries, null, 2), 'utf8');

	        // Also write a markdown summary
	        const mdLines: string[] = ['# Copilot Export', `Export date: ${new Date().toLocaleString()}`, '', `Total entries: ${allEntries.length}`, ''];
	        for (const e of allEntries) {
	          mdLines.push('---');
	          mdLines.push(`**Session:** ${e.content.session || ''}`);
	          mdLines.push(`**Date:** ${e.content.date || ''}`);
	          mdLines.push('');
	          mdLines.push('**Human:**');
	          mdLines.push('');
	          mdLines.push(e.content.human || '');
	          mdLines.push('');
	          mdLines.push('**Copilot:**');
	          mdLines.push('');
	          mdLines.push(e.content.copilot || '');
	          mdLines.push('');
	        }
	        const mdFile = outputFile.replace(/\.json$/, '.md');
	        await writeFile(mdFile, mdLines.join('\n'), 'utf8');

	        const message = `Copilot export complete! ${allEntries.length} entries exported to ${outputFile}`;
	        const action = await vscode.window.showInformationMessage(message, 'Open File', 'Open Folder');
	        if (action === 'Open File') {
	          vscode.commands.executeCommand('vscode.open', vscode.Uri.file(outputFile));
	        } else if (action === 'Open Folder') {
	          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outDir));
	        }
	      } else {
	        const diagnosticReport = [
	          '🔍 **Copilot Export Diagnostics**',
	          '',
	          '**Search Details:**',
	          ...diagnostics.map(d => `• ${d}`),
	          '',
	          '**Possible Solutions:**',
	          '• Make sure you have used GitHub Copilot Chat in this workspace',
	          "• Try opening a different workspace where you've used Copilot",
	          '• Check if VS Code is storing data in a custom location',
	          '• On Windows, data might be in a different AppData folder',
	          '• The extension looks for chat sessions from the last 30 days'
	        ].join('\n');

	        const diagnosticFile = path.join(outDir, `copilot_export_diagnostics_${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
	        await writeFile(diagnosticFile, diagnosticReport, 'utf8');
	        const action = await vscode.window.showWarningMessage('No Copilot data found. Click "View Details" to see diagnostic information.', 'View Details', 'Close');
	        if (action === 'View Details') {
	          vscode.commands.executeCommand('vscode.open', vscode.Uri.file(diagnosticFile));
	        }
	      }

	    } catch (error) {
			vscode.window.showErrorMessage('Copilot export failed: ' + String(error));
	    }
	});

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('github-copilot-chat-archiver.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from Github Copilot Chat Archiver!');
	});

	context.subscriptions.push(statusBarItem, exportCommand, disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
