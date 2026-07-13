class LlmNow < Formula
  desc "Run one prompt against an available local or cloud LLM"
  homepage "https://github.com/swartzrock/llm-now"
  version "__PACKAGE_VERSION__"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "__MACOS_ARM64_URL__"
      sha256 "__MACOS_ARM64_SHA256__"
    else
      url "__MACOS_X64_URL__"
      sha256 "__MACOS_X64_SHA256__"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "__LINUX_ARM64_URL__"
      sha256 "__LINUX_ARM64_SHA256__"
    else
      url "__LINUX_X64_URL__"
      sha256 "__LINUX_X64_SHA256__"
    end
  end

  def install
    bin.install "llm-now"
  end

  test do
    assert_match "Usage:", shell_output("#{bin}/llm-now --help")
  end
end
