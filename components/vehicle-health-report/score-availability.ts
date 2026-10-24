/** Only explicit insufficient history suppresses scores; legacy reports stay eligible. */
export function isReportScoreAvailable(dataQuality?: { sufficient: boolean } | null): boolean {
  return dataQuality?.sufficient !== false;
}
