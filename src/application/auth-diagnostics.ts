export type AuthDiagnosticValue = string | number | boolean;
export type AuthDiagnostic = (
  event: string,
  details: Readonly<Record<string, AuthDiagnosticValue>>,
) => void;

export const noopAuthDiagnostic: AuthDiagnostic = () => undefined;

export const productionAuthDiagnostic: AuthDiagnostic = (event, details) => {
  console.warn(
    JSON.stringify({
      component: "echohoard-auth",
      event,
      ...details,
    }),
  );
};
