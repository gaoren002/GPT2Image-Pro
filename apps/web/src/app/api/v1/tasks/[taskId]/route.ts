import { corsPreflight, corsRoute } from "@/features/external-api/cors";
import { getExternalTask } from "@/features/external-api/handlers/tasks";

export const GET = corsRoute(getExternalTask);
export const OPTIONS = corsPreflight;
