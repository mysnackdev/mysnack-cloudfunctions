export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: any };
  message?: string;
}
export const successResponse = <T>(data: T, message?: string): ApiResponse<T> =>
  ({ success: true, data, message });
export const errorResponse = (code: string, message: string, details?: any): ApiResponse =>
  ({ success: false, error: { code, message, details } });
export const handleErrors = async <T>(fn: () => Promise<T>): Promise<ApiResponse<T>> => {
  try { return successResponse(await fn()); }
  catch (e: any) { return errorResponse(e.code || "internal", e.message || "Erro interno do servidor", e); }
};
