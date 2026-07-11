export interface Message {
  id: string;

  playerId: string;

  text: string;

  mediaUrl?: string;

  createdAt: Date;
}
