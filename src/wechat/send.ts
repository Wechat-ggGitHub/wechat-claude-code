import { WeChatApi } from './api.js';
import { MessageItemType, MessageType, MessageState, type MessageItem, type OutboundMessage } from './types.js';
import { uploadFile, type UploadResult } from './cdn.js';
import { logger } from '../logger.js';

export function createSender(api: WeChatApi, botAccountId: string) {
  let clientCounter = 0;

  function generateClientId(): string {
    return `wcc-${Date.now()}-${++clientCounter}`;
  }

  async function sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    const clientId = generateClientId();

    const items: MessageItem[] = [
      {
        type: MessageItemType.TEXT,
        text_item: { text },
      },
    ];

    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };

    logger.info('Sending text message', { toUserId, clientId, textLength: text.length });
    await api.sendMessage({ msg });
    logger.info('Text message sent', { toUserId, clientId });
  }

  /**
   * Upload a local file to WeChat CDN and send it as a file message.
   */
  async function sendFile(toUserId: string, contextToken: string, filePath: string): Promise<void> {
    const clientId = generateClientId();

    const result: UploadResult = await uploadFile(
      filePath,
      toUserId,
      (params) => api.getUploadUrl(params),
    );

    const items: MessageItem[] = [
      {
        type: MessageItemType.FILE,
        file_item: {
          media: {
            encrypt_query_param: result.encryptQueryParam,
            aes_key: result.aesKeyBase64,
            encrypt_type: 1,
          },
          file_name: result.fileName,
          md5: result.md5,
          len: String(result.fileSize),
        },
      },
    ];

    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };

    logger.info('Sending file message', { toUserId, clientId, fileName: result.fileName, fileSize: result.fileSize });
    await api.sendMessage({ msg });
    logger.info('File message sent', { toUserId, clientId });
  }

  /**
   * Upload a local image to WeChat CDN and send it as an image message.
   */
  async function sendImage(toUserId: string, contextToken: string, filePath: string): Promise<void> {
    const clientId = generateClientId();

    const result: UploadResult = await uploadFile(
      filePath,
      toUserId,
      (params) => api.getUploadUrl(params),
    );

    const items: MessageItem[] = [
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: result.encryptQueryParam,
            aes_key: result.aesKeyBase64,
            encrypt_type: 1,
          },
          mid_size: result.encryptedSize,
          hd_size: result.encryptedSize,
        },
      },
    ];

    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };

    logger.info('Sending image message', { toUserId, clientId, fileName: result.fileName, fileSize: result.fileSize });
    await api.sendMessage({ msg });
    logger.info('Image message sent', { toUserId, clientId });
  }

  /**
   * Upload a local video to WeChat CDN and send it as a video message.
   */
  async function sendVideo(toUserId: string, contextToken: string, filePath: string): Promise<void> {
    const clientId = generateClientId();

    const result: UploadResult = await uploadFile(
      filePath,
      toUserId,
      (params) => api.getUploadUrl(params),
    );

    const items: MessageItem[] = [
      {
        type: MessageItemType.VIDEO,
        video_item: {
          media: {
            encrypt_query_param: result.encryptQueryParam,
            aes_key: result.aesKeyBase64,
            encrypt_type: 1,
          },
          video_size: result.encryptedSize,
          video_md5: result.md5,
        },
      },
    ];

    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };

    logger.info('Sending video message', { toUserId, clientId, fileName: result.fileName, fileSize: result.fileSize });
    await api.sendMessage({ msg });
    logger.info('Video message sent', { toUserId, clientId });
  }

  /**
   * Auto-detect file type and send using the appropriate method.
   */
  async function sendMedia(toUserId: string, contextToken: string, filePath: string): Promise<void> {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
    const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'm4v', '3gp'];

    if (imageExts.includes(ext)) {
      await sendImage(toUserId, contextToken, filePath);
    } else if (videoExts.includes(ext)) {
      await sendVideo(toUserId, contextToken, filePath);
    } else {
      await sendFile(toUserId, contextToken, filePath);
    }
  }

  return { sendText, sendFile, sendImage, sendVideo, sendMedia };
}
