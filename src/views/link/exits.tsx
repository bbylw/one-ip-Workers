import { useEffect } from "react";
import { t } from "@/i18n";
import { SplitResults } from "@/views/home/split-results";

export default function ExitsPage() {
  useEffect(() => {
    document.title = t("分流出口 - IP 网络工具");
  }, []);
  return (
    <>
      <header className="console-bar page-heading">
        <h1 className="console-heading">{t("分流出口")}</h1>
      </header>
      <SplitResults />
    </>
  );
}
