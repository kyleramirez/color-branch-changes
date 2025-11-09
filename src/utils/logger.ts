import { ExtensionContext, OutputChannel, window as VSCodeWindow } from 'vscode';

function generateLogger() {
  let outputChannel: OutputChannel | undefined;
  function logger(extensionContext: ExtensionContext): void;
  function logger(message: string): void;
  function logger(extensionContextOrMessage: ExtensionContext | string): void {
    if (outputChannel && typeof extensionContextOrMessage === 'string') {
      outputChannel.appendLine(extensionContextOrMessage);
    } else if (typeof extensionContextOrMessage !== 'string') {
      outputChannel = VSCodeWindow.createOutputChannel('Color Branch Changes');
      extensionContextOrMessage.subscriptions.push(outputChannel);
    }
  }
  return logger;
}

export default generateLogger();
