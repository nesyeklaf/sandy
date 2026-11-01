import type {
  EditMessageRequest,
  SendMessageRequest,
} from "@sandy/server-contract";

export interface SendThreadMessageMutationRequest extends SendMessageRequest {
  id: string;
}

export interface EditMessageMutationRequest extends EditMessageRequest {
  id: string;
}
