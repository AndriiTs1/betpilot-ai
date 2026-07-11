export type PlayerStatus = "ACTIVE" | "BLOCKED";

export interface Player {
  id: string;

  name: string;

  phone: string;

  status: PlayerStatus;

  createdAt: Date;
}
