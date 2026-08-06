# typed: false
# frozen_string_literal: true

class LlmNow < Formula
  desc "Make one text-generation call through an available LLM provider"
  homepage "https://github.com/swartzrock/llm-now"
  version "__PACKAGE_VERSION__"
  license "MIT"

  on_macos do
    on_arm do
      url "__MACOS_ARM64_URL__"
      sha256 "__MACOS_ARM64_SHA256__"
    end

    on_intel do
      url "__MACOS_X64_URL__"
      sha256 "__MACOS_X64_SHA256__"
    end
  end

  on_linux do
    on_arm do
      url "__LINUX_ARM64_URL__"
      sha256 "__LINUX_ARM64_SHA256__"
    end

    on_intel do
      url "__LINUX_X64_URL__"
      sha256 "__LINUX_X64_SHA256__"
    end
  end

  def install
    bin.install "llm-now"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/llm-now --version")
  end
end
