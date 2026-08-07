export interface LoginRequest {
  serverUrl: string;
  username: string;
  password: string;
  deviceId: string;
}

export interface JellyfinAuthResponse {
  User: {
    Id: string;
    Name: string;
    [key: string]: unknown;
  };
  AccessToken: string;
  ServerId: string;
  [key: string]: unknown;
}

export interface LoginSuccessResponse {
  user: {
    id: string;
    name: string;
  };
  serverUrl: string;
}
