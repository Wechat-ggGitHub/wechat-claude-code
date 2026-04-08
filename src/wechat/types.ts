// WeChat iLink Bot protocol type definitions
// Based on: https://github.com/epiral/weixin-bot/blob/main/docs/protocol-spec.md

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
  encrypt_query_param: string;
  aes_key: string;
  full_url?: string; // Complete CDN URL including taskid — needed for re-sent files
  encrypt_type?: number; // 0 = only file id encrypted, 1 = packed with thumb etc.
}

// ── Message Items ───────────────────────────────────────────────────────────

export interface TextItem {
  text: string;
}

export interface ImageItem {
  cdn_media?: CDNMedia;
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  hd_size?: number;
  thumb_size?: number;
  thumb_width?: number;
  thumb_height?: number;
}

export interface VoiceItem {
  cdn_media?: CDNMedia;
  media?: CDNMedia;
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number;
  text?: string;
}

export interface FileItem {
  cdn_media?: CDNMedia;
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface VideoItem {
  cdn_media?: CDNMedia;
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_width?: number;
  thumb_height?: number;
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

/** media_type values for getuploadurl */
export enum MediaType {
  IMAGE = 1,
  VIDEO = 2,
  FILE = 3,
  VOICE = 4,
}

export interface GetUploadUrlReq {
  filekey: string;
  media_type: MediaType;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  no_need_thumb: boolean;
  aeskey: string;
  base_info: {
    channel_version: string;
  };
}

export interface GetUploadUrlResp {
  ret?: number;
  errcode?: number;
  upload_param?: string;
  thumb_upload_param?: string;
}
