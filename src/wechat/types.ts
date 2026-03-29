// WeChat Work (企业微信) protocol type definitions
// Extracted from the ClawBot WeChat plugin API

// ── Enums ──────────────────────────────────────────────────────────────────

export enum MessageType {
  USER = 1,
  BOT = 2,
}

export enum MessageItemType {
  TEXT = 1,
  IMAGE = 2,
  VOICE = 3,
  FILE = 4,
  VIDEO = 5,
}

export enum MessageState {
  NEW = 0,
  GENERATING = 1,
  FINISH = 2,
}

// ── Media ──────────────────────────────────────────────────────────────────

export interface CDNMedia {
  aes_key: string;
  encrypt_query_param: string;
  cdn_url?: string;
}

// ── Message Items ───────────────────────────────────────────────────────────

export interface TextItem {
  text: string;
}

export interface ImageItem {
  cdn_media?: CDNMedia;
  /** Alternative field name used by some API versions */
  aeskey?: string;
  media?: { encrypt_query_param: string; aes_key?: string };
  url?: string;
  mid_size?: number;
  hd_size?: number;
}

export interface VoiceItem {
  cdn_media: CDNMedia;
  voice_text?: string;
}

export interface FileItem {
  cdn_media: CDNMedia;
  file_name?: string;
}

export interface VideoItem {
  cdn_media: CDNMedia;
}

export interface MessageItem {
  type: MessageItemType;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

// ── Weixin Message ──────────────────────────────────────────────────────────

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  message_type?: MessageType;
  message_state?: MessageState;
  item_list?: MessageItem[];
  context_token?: string;
}

// ── GetUpdates API ──────────────────────────────────────────────────────────

export interface GetUpdatesReq {
  get_updates_buf?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  retmsg?: string;
  sync_buf: string;
  get_updates_buf: string;
  msgs?: WeixinMessage[];
}

// ── SendMessage API ─────────────────────────────────────────────────────────

export interface OutboundMessage {
  from_user_id: string;
  to_user_id: string;
  client_id: string;
  message_type: MessageType;
  message_state: MessageState;
  context_token: string;
  item_list: MessageItem[];
}

export interface SendMessageReq {
  msg: OutboundMessage;
}

// ── GetUploadUrl API ────────────────────────────────────────────────────────

export interface GetUploadUrlReq {
  file_type: string;
  file_size: number;
  file_name: string;
}

export interface GetUploadUrlResp {
  errcode: number;
  url: string;
  aes_key: string;
  encrypt_query_param: string;
}
