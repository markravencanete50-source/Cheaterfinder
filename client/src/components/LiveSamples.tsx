import { useLocation } from "wouter";
import { Activity } from "lucide-react";

const celebs = [
  { handle: "kimkardashian", name: "Kim Kardashian", time: "1 week snapshot", image: "/celebs/kim.webp" },
  { handle: "justinbieber", name: "Justin Bieber", time: "1 month snapshot", image: "/celebs/justin.webp" },
  { handle: "selenagomez", name: "Selena Gomez", time: "1 week snapshot", image: "/celebs/selena.webp" },
  { handle: "cristiano", name: "Cristiano Ronaldo", time: "1 month snapshot", image: "/celebs/cristiano.webp" },
  { handle: "taylorswift", name: "Taylor Swift", time: "1 week snapshot", image: "/celebs/taylor.webp" },
];

export function LiveSamples() {
  const [, setLocation] = useLocation();

  return (
    <section className="py-12 bg-white overflow-hidden flex flex-col items-center relative z-20 border-b border-slate-100">
      <div className="container mx-auto px-4 text-center mb-8">
        <p className="text-sm font-bold text-slate-600 uppercase tracking-widest">Or view a sample report</p>
      </div>
      
      {/* Marquee Container */}
      <div className="w-full relative flex overflow-hidden group">
        {/* Fading edges */}
        <div className="absolute left-0 top-0 bottom-0 w-24 md:w-48 bg-gradient-to-r from-white to-transparent z-10 pointer-events-none" />
        <div className="absolute right-0 top-0 bottom-0 w-24 md:w-48 bg-gradient-to-l from-white to-transparent z-10 pointer-events-none" />
        
        <div className="flex animate-marquee group-hover:[animation-play-state:paused] w-max">
          {/* Double the list for seamless looping */}
          {[...celebs, ...celebs, ...celebs].map((celeb, i) => (
            <div 
              key={i}
              onClick={() => setLocation("/auth")}
              className="flex items-center gap-4 mx-4 p-3 pr-6 rounded-full border border-slate-200 bg-white shadow-sm hover:border-primary hover:shadow-md transition-all cursor-pointer shrink-0"
            >
              <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-primary to-pink-500 p-[2px] shrink-0">
                <div className="w-full h-full rounded-full border-2 border-white bg-slate-100 flex items-center justify-center overflow-hidden">
                  <img src={celeb.image} alt={celeb.name} className="w-full h-full object-cover" />
                </div>
              </div>
              <div>
                <p className="font-bold text-slate-900 group-hover:text-primary transition-colors">@{celeb.handle}</p>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="flex items-center gap-1"><Activity className="w-3 h-3 text-emerald-500" /> {celeb.time}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
