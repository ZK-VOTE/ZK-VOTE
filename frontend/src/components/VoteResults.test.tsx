import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import VoteResults from "./VoteResults";

describe("VoteResults", () => {
  describe("Rendering vote counts", () => {
    it("renders yes and no vote counts", () => {
      render(<VoteResults yesVotes={7} noVotes={3} isOpen={true} />);

      expect(screen.getByText("7 Yes")).toBeInTheDocument();
      expect(screen.getByText("3 No")).toBeInTheDocument();
    });

    it("renders total votes", () => {
      render(<VoteResults yesVotes={7} noVotes={3} isOpen={true} />);

      expect(screen.getByText("10 votes total")).toBeInTheDocument();
    });

    it("renders Results heading", () => {
      render(<VoteResults yesVotes={5} noVotes={5} isOpen={true} />);

      expect(screen.getByText("Results")).toBeInTheDocument();
    });
  });

  describe("Percentage calculations", () => {
    it("shows correct percentages for yes/no votes", () => {
      render(<VoteResults yesVotes={3} noVotes={1} isOpen={true} />);

      // 3/4 = 75%, 1/4 = 25%
      expect(screen.getByText("75.0% Yes")).toBeInTheDocument();
      expect(screen.getByText("25.0% No")).toBeInTheDocument();
    });

    it("shows 100% yes when all votes are yes", () => {
      render(<VoteResults yesVotes={10} noVotes={0} isOpen={true} />);

      expect(screen.getByText("100.0% Yes")).toBeInTheDocument();
      expect(screen.getByText("0.0% No")).toBeInTheDocument();
    });

    it("shows 100% no when all votes are no", () => {
      render(<VoteResults yesVotes={0} noVotes={5} isOpen={true} />);

      expect(screen.getByText("0.0% Yes")).toBeInTheDocument();
      expect(screen.getByText("100.0% No")).toBeInTheDocument();
    });

    it("shows 50/50 split correctly", () => {
      render(<VoteResults yesVotes={4} noVotes={4} isOpen={true} />);

      expect(screen.getByText("50.0% Yes")).toBeInTheDocument();
      expect(screen.getByText("50.0% No")).toBeInTheDocument();
    });
  });

  describe("Zero votes", () => {
    it("shows 0 yes and 0 no when no votes", () => {
      render(<VoteResults yesVotes={0} noVotes={0} isOpen={true} />);

      expect(screen.getByText("0 Yes")).toBeInTheDocument();
      expect(screen.getByText("0 No")).toBeInTheDocument();
    });

    it("shows 0 votes total when no votes", () => {
      render(<VoteResults yesVotes={0} noVotes={0} isOpen={true} />);

      expect(screen.getByText("0 votes total")).toBeInTheDocument();
    });

    it("does not show percentage labels when no votes", () => {
      render(<VoteResults yesVotes={0} noVotes={0} isOpen={true} />);

      // Percentage labels are only shown when totalVotes > 0
      expect(screen.queryByText(/% Yes/)).not.toBeInTheDocument();
      expect(screen.queryByText(/% No/)).not.toBeInTheDocument();
    });
  });

  describe("Progress bar", () => {
    it("renders green and red progress bar segments", () => {
      const { container } = render(
        <VoteResults yesVotes={6} noVotes={4} isOpen={true} />,
      );

      const greenBar = container.querySelector(".bg-green-500");
      const redBar = container.querySelector(".bg-red-500");
      expect(greenBar).toBeTruthy();
      expect(redBar).toBeTruthy();
    });

    it("sets correct width styles on progress bars", () => {
      const { container } = render(
        <VoteResults yesVotes={3} noVotes={1} isOpen={true} />,
      );

      const greenBar = container.querySelector(".bg-green-500") as HTMLElement;
      const redBar = container.querySelector(".bg-red-500") as HTMLElement;

      expect(greenBar.style.width).toBe("75%");
      expect(redBar.style.width).toBe("25%");
    });

    it("sets 0% width for both bars when no votes", () => {
      const { container } = render(
        <VoteResults yesVotes={0} noVotes={0} isOpen={true} />,
      );

      const greenBar = container.querySelector(".bg-green-500") as HTMLElement;
      const redBar = container.querySelector(".bg-red-500") as HTMLElement;

      expect(greenBar.style.width).toBe("0%");
      expect(redBar.style.width).toBe("0%");
    });
  });

  describe("isOpen prop", () => {
    it("renders with isOpen true", () => {
      render(<VoteResults yesVotes={5} noVotes={3} isOpen={true} />);

      // Component renders regardless of isOpen (it doesn't use isOpen in current implementation)
      expect(screen.getByText("Results")).toBeInTheDocument();
    });

    it("renders with isOpen false", () => {
      render(<VoteResults yesVotes={5} noVotes={3} isOpen={false} />);

      expect(screen.getByText("Results")).toBeInTheDocument();
    });
  });

  describe("Large numbers", () => {
    it("handles large vote counts", () => {
      render(<VoteResults yesVotes={1000} noVotes={500} isOpen={true} />);

      expect(screen.getByText("1000 Yes")).toBeInTheDocument();
      expect(screen.getByText("500 No")).toBeInTheDocument();
      expect(screen.getByText("1500 votes total")).toBeInTheDocument();
    });

    it("calculates correct percentages for large numbers", () => {
      render(<VoteResults yesVotes={1000} noVotes={500} isOpen={true} />);

      // 1000/1500 = 66.7%, 500/1500 = 33.3%
      expect(screen.getByText("66.7% Yes")).toBeInTheDocument();
      expect(screen.getByText("33.3% No")).toBeInTheDocument();
    });
  });
});
